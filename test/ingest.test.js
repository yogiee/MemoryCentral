// Ingest, reconciliation and the shared write paths (2026-10-09).
//
// The rule these guard: MemoryCentral retains knowledge. Only a deliberate removal
// takes a memory out of search — an unreadable folder, a vanished folder or a mass
// disappearance never does. Every test runs against its own throwaway data root and
// fake Claude projects folder; nothing touches the real index.
// Run: cd server && npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, chmodSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseSync } from 'node:sqlite';

let tmp, home, claude, db, mods;

// The Claude adapter decodes folder names against the real home directory, so the
// fake repo paths live under a tmp dir and are encoded the same way Claude does.
const enc = p => p.replace(/[/\\]/g, '-');

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mc-ingest-'));
  home = join(tmp, 'mc-home');
  claude = join(tmp, 'claude-projects');
  mkdirSync(claude, { recursive: true });
  process.env.MEMORYCENTRAL_HOME = home;
  process.env.MC_CLAUDE_PROJECTS = claude;
  process.env.MC_RC_PATH = join(tmp, 'no-rc.json');
  process.env.MC_CLAUDE_HOME = tmp;
  mods = {
    ...(await import('../server/db.js')),
    ...(await import('../server/ingest.js')),
    ...(await import('../server/store.js')),
    ...(await import('../server/settings.js')),
  };
  db = mods.openDb();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// A Claude-style project: <claude>/<encoded repo path>/memory/*.md, plus the repo.
function claudeProject(name, files, block = null) {
  const repo = join(tmp, 'repos', name);
  mkdirSync(repo, { recursive: true });
  if (block) writeFileSync(join(repo, 'AGENTS.md'), `# ${name}\n\n${block}\n`);
  const mem = join(claude, enc(repo), 'memory');
  mkdirSync(mem, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(mem, f), c);
  return { repo, mem };
}

const sync = () => mods.syncAll(db, { embed: false });
const live = name => db.prepare('SELECT m.* FROM memories m JOIN projects p ON p.id=m.project_id WHERE p.name=? ORDER BY filename').all(name);
const tombs = () => db.prepare('SELECT * FROM memory_tombstones').all();
const files = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`note_${i}.md`, `# Note ${i}\n\nbody ${i}`]));

test('ingests harness memories; the project block names and describes the project', async () => {
  claudeProject('app', { 'a.md': '# A\n\nalpha', 'MEMORY.md': '- index', '_draft.md': 'x' },
    '## MemoryCentral\nProject: Billing App\nDescription: Invoices and payments.\nStack: node, postgres');
  const s = await sync();
  assert.equal(s.added, 1, 'MEMORY.md and _-prefixed files are not memories');
  const p = db.prepare('SELECT * FROM projects').get();
  assert.equal(p.name, 'Billing App');
  assert.equal(p.description, 'Invoices and payments.');
  assert.deepEqual(JSON.parse(p.stack), ['node', 'postgres']);
  assert.equal(p.meta_file, 'AGENTS.md');
  assert.equal(db.prepare('SELECT kind FROM sources').get().kind, 'claude');
});

test('one file deleted from a readable folder is tombstoned, and comes back if the file does', async () => {
  const { mem } = claudeProject('app', files(4));
  await sync();
  unlinkSync(join(mem, 'note_1.md'));
  const s = await sync();
  assert.equal(s.tombstoned, 1);
  assert.equal(live('app').length, 3);
  assert.equal(tombs()[0].filename, 'note_1.md');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memories_fts WHERE memories_fts MATCH 'body'").get().n, 3, 'gone from search too');

  writeFileSync(join(mem, 'note_1.md'), '# Note 1\n\nbody 1');
  await sync();
  assert.equal(live('app').length, 4);
  assert.equal(tombs().length, 0, 'a returning file clears its tombstone');
});

test('a mass disappearance is held, not applied, until confirmed', async () => {
  const { mem } = claudeProject('app', files(10));
  await sync();
  for (let i = 0; i < 6; i++) unlinkSync(join(mem, `note_${i}.md`));
  const s = await sync();
  assert.equal(s.held, 6);
  assert.equal(s.tombstoned, 0);
  assert.equal(live('app').length, 10, 'nothing removed while held');
  const src = db.prepare('SELECT * FROM sources').get();
  assert.equal(src.status, 'suspect');

  const r = mods.confirmHeldRemovals(db, src.id);
  assert.equal(r.tombstoned, 6);
  assert.equal(live('app').length, 4);
});

test('an unreadable folder removes nothing', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { mem } = claudeProject('app', files(3));
  await sync();
  chmodSync(mem, 0o000);
  try {
    const s = await sync();
    assert.equal(s.tombstoned, 0);
    assert.equal(s.held, 0);
    assert.equal(live('app').length, 3);
    assert.equal(db.prepare('SELECT status FROM sources').get().status, 'unavailable');
  } finally {
    chmodSync(mem, 0o755);
  }
});

test('a folder that vanishes entirely keeps its memories, marked missing; adopting copies them home', async () => {
  const { mem } = claudeProject('app', files(3));
  await sync();
  rmSync(join(mem, '..'), { recursive: true, force: true });
  const s = await sync();
  assert.equal(s.tombstoned, 0);
  assert.equal(live('app').length, 3, 'still searchable');
  const src = db.prepare('SELECT * FROM sources').get();
  assert.equal(src.status, 'missing');
  assert.ok(src.missing_since);

  const r = mods.adoptSource(db, src.id);
  assert.equal(r.adopted, 3);
  assert.ok(existsSync(join(r.root, 'note_0.md')));
  await sync();
  assert.equal(live('app').length, 3);
  assert.equal(db.prepare('SELECT kind FROM sources').get().kind, 'native');
});

test('a rename keeps the row (and therefore its vectors)', async () => {
  const { mem } = claudeProject('app', { 'old.md': '---\nname: same title\n---\nunchanged body' });
  await sync();
  const before = live('app')[0];
  db.prepare("INSERT INTO embeddings VALUES (?, 0, 0, 10, '[1]', 'm', ?, 'now')").run(before.id, before.embed_hash);
  renameSync(join(mem, 'old.md'), join(mem, 'new.md'));
  const s = await sync();
  assert.equal(s.renamed, 1);
  const after = live('app')[0];
  assert.equal(after.id, before.id);
  assert.equal(after.filename, 'new.md');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM embeddings WHERE memory_id=?').get(after.id).n, 1, 'vector kept');
  assert.equal(tombs().length, 0);
});

test('save_memory: a new project lands in MemoryCentral\'s own store', async () => {
  const r = await mods.saveMemory(db, { project: 'Copilot Thing', filename: 'decision.md', content: '# D\n\nwe chose X', embed: false });
  assert.ok(r.ok && r.created);
  assert.ok(r.path.startsWith(join(home, 'projects')));
  assert.equal(live('Copilot Thing').length, 1);
  await sync();
  assert.equal(live('Copilot Thing').length, 1, 'a sync re-reads the same file, no duplicate');
  assert.equal(db.prepare("SELECT kind FROM sources").get().kind, 'native');
});

test('save_memory updates an existing harness memory where it lives', async () => {
  const { mem } = claudeProject('app', { 'a.md': 'v1' });
  await sync();
  const r = await mods.saveMemory(db, { project: 'app', filename: 'a.md', content: 'v2', embed: false });
  assert.equal(r.path, join(mem, 'a.md'));
  assert.equal(readFileSync(join(mem, 'a.md'), 'utf8'), 'v2');
  assert.equal(live('app').length, 1);
  assert.ok(!existsSync(join(home, 'projects')), 'no copy forked into the native store');
});

test('save_memory follows a harness file the index has not seen yet (same-file habit)', async () => {
  const { mem } = claudeProject('app', { 'a.md': 'first' });
  await sync();
  writeFileSync(join(mem, 'b.md'), 'written by the harness');
  const r = await mods.saveMemory(db, { project: 'app', filename: 'b.md', content: 'written by the harness', embed: false });
  assert.equal(r.path, join(mem, 'b.md'));
  await sync();
  assert.equal(live('app').length, 2);
});

test('save_memory rejects paths and index files', async () => {
  for (const f of ['../x.md', 'a/b.md', 'MEMORY.md', '_x.md', 'notes.txt', '']) {
    const r = await mods.saveMemory(db, { project: 'p', filename: f, content: 'x', embed: false });
    assert.equal(r.ok, false, f);
  }
});

test('delete_memory is a deliberate delete: file and row gone, no tombstone', async () => {
  const { mem } = claudeProject('app', files(2));
  await sync();
  const r = mods.deleteMemory(db, { project: 'app', filename: 'note_0.md' });
  assert.ok(r.ok && r.fileRemoved);
  assert.ok(!existsSync(join(mem, 'note_0.md')));
  assert.equal(live('app').length, 1);
  await sync();
  assert.equal(tombs().length, 0);
});

test('a tombstone restores to its original folder', async () => {
  const { mem } = claudeProject('app', files(3));
  await sync();
  unlinkSync(join(mem, 'note_2.md'));
  await sync();
  const r = await mods.restoreTombstone(db, tombs()[0].id, { embed: false });
  assert.ok(r.ok);
  assert.equal(r.path, join(mem, 'note_2.md'));
  assert.equal(live('app').length, 3);
  assert.equal(tombs().length, 0);
});

test('the same file in two folders of one project is one memory', async () => {
  claudeProject('app', { 'a.md': 'same' });
  await sync();
  const native = join(home, 'projects', 'app', 'memory');
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, '..', 'project.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(join(native, 'a.md'), 'same');
  const s = await sync();
  assert.equal(live('app').length, 1);
  assert.equal(s.conflicts.length, 0);
});

test('only one process syncs at a time', async () => {
  assert.equal(mods.acquireLease(db, 'sync', 'other-process', 60_000), true);
  const s = await mods.syncAll(db, { embed: false, holder: 'me' });
  assert.equal(s.skipped, 'busy');
  mods.releaseLease(db, 'sync', 'other-process');
  assert.ok(!(await mods.syncAll(db, { embed: false, holder: 'me' })).skipped);
});

test('a pre-2026-10-09 index migrates in place: rows keep their ids and vectors', async () => {
  const legacy = join(tmp, 'legacy.db');
  const old = new DatabaseSync(legacy);
  old.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, encoded_path TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '', stack TEXT DEFAULT '[]', last_synced TEXT, meta_hash TEXT);
    CREATE TABLE memories (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, memory_type TEXT DEFAULT 'general', title TEXT DEFAULT '', content TEXT NOT NULL,
      embed_hash TEXT DEFAULT '', synced_at TEXT NOT NULL, UNIQUE(project_id, filename));
    CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, project_name UNINDEXED, memory_type UNINDEXED);
    CREATE TABLE embeddings (memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE, chunk_index INTEGER NOT NULL,
      start_char INTEGER NOT NULL, end_char INTEGER NOT NULL, vector TEXT NOT NULL, model TEXT NOT NULL,
      embed_hash TEXT NOT NULL, generated_at TEXT NOT NULL, PRIMARY KEY (memory_id, chunk_index));
    CREATE TABLE sync_events (id INTEGER PRIMARY KEY, synced_at TEXT NOT NULL, projects_synced INTEGER DEFAULT 0,
      files_added INTEGER DEFAULT 0, files_updated INTEGER DEFAULT 0, files_unchanged INTEGER DEFAULT 0);
  `);
  const { repo, mem } = claudeProject('app', { 'a.md': 'alpha', 'gone.md': 'orphan' });
  unlinkSync(join(mem, 'gone.md')); // a row whose file disappeared before sources existed
  old.prepare("INSERT INTO projects (id, name, encoded_path) VALUES (7, 'app', ?)").run(enc(repo));
  old.prepare("INSERT INTO memories (id, project_id, filename, content, synced_at) VALUES (41, 7, 'a.md', 'alpha', 'then')").run();
  old.prepare("INSERT INTO memories (id, project_id, filename, content, synced_at) VALUES (42, 7, 'gone.md', 'orphan', 'then')").run();
  old.prepare("INSERT INTO embeddings VALUES (41, 0, 0, 5, '[1]', 'm', 'h', 'then')").run();
  old.close();

  db.close();
  db = mods.openDb(legacy);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.ok(db.prepare('SELECT content_hash FROM memories WHERE id=41').get().content_hash);
  await sync();
  const rows = live('app');
  assert.deepEqual(rows.map(r => r.id), [41, 42], 'same rows, no duplicates');
  assert.ok(rows.find(r => r.id === 41).source_id, 'claimed by its folder');
  assert.equal(rows.find(r => r.id === 42).source_id, null, 'an orphan is kept, never guessed at or deleted');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM embeddings WHERE memory_id=41').get().n, 1, 'vector survived');
  assert.equal(tombs().length, 0);
});
