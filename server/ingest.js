// Ingest: bring the index in line with every source's files.
//
// One pass (syncAll) discovers each source folder (sources.js), reads it in full,
// and reconciles it with the index:
//
//   new file                      → inserted, embedded
//   changed file                  → updated, re-embedded
//   file renamed (same content)   → row renamed in place; vectors kept
//   file missing, folder readable → TOMBSTONED: hidden from search at once,
//                                   restorable, purged after TOMBSTONE_DAYS
//   many files missing at once    → HELD: the source is marked 'suspect' and nothing
//                                   is removed until someone confirms on the dashboard
//   folder unreadable             → source 'unavailable'; nothing removed
//   folder gone entirely          → source 'missing'; its memories stay searchable
//
// The rule underneath all of it: MemoryCentral retains knowledge. Only a removal
// that is clearly deliberate — one file deleted from a folder that otherwise reads
// fine, or an explicit delete_memory — takes a memory out of search, and even then
// it can be restored for a month.

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { contentHash } from './db.js';
import { embedHash } from './chunk.js';
import { memoryType, extractTitle } from './meta.js';
import { ADAPTERS, scanSource } from './sources.js';
import { readProjectMeta, fallbackDescription } from './projectBlock.js';
import { getSetting, acquireLease, releaseLease, importRcOnce } from './settings.js';
import { extractConfig, extractProjectMeta, projectDigest } from './extract.js';
import { createHash } from 'crypto';
import { drainPending, countPending, embedMemory } from './backlog.js';
import { generatedDir, safeDirName } from './paths.js';

export const TOMBSTONE_DAYS = 30;

// A removal is "mass" — and held for confirmation — when more than MASS_MIN files
// AND more than MASS_SHARE of a source vanish in one scan. A moved folder, a sync
// tool mid-way through, a cleared directory: none of those should cost memories.
export const MASS_MIN = 5;
export const MASS_SHARE = 0.3;

// How long a sync may hold the cross-process lease before another process may take
// it over (a crashed holder). Far above any real sync, which takes seconds.
const LEASE_MS = 10 * 60_000;

// Project rows are keyed by name. encoded_path is a legacy unique column (it held
// Claude's encoded directory name); new projects get "<kind>:<name>" there.
export function ensureProject(db, name, { repoPath = null, kind = 'native', now = new Date().toISOString() } = {}) {
  db.prepare(`
    INSERT INTO projects (name, encoded_path, last_synced, description, stack, repo_path)
    VALUES (?, ?, ?, '', '[]', ?)
    ON CONFLICT(name) DO UPDATE SET repo_path = COALESCE(excluded.repo_path, projects.repo_path)
  `).run(name, `${kind}:${name}`, now, repoPath);
  return db.prepare('SELECT * FROM projects WHERE name=?').get(name);
}

export function ensureSource(db, projectId, kind, root) {
  db.prepare(`
    INSERT INTO sources (project_id, kind, root) VALUES (?, ?, ?)
    ON CONFLICT(kind, root) DO UPDATE SET project_id = excluded.project_id
  `).run(projectId, kind, root);
  return db.prepare('SELECT * FROM sources WHERE kind=? AND root=?').get(kind, root);
}

// Moves a live memory into the tombstone table. Its vectors go with the row
// (ON DELETE CASCADE); a restore re-embeds.
export function tombstone(db, mem, reason, now = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO memory_tombstones (project_id, source_id, filename, title, memory_type, content, content_hash, deleted_at, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(mem.project_id, mem.source_id, mem.filename, mem.title, mem.memory_type, mem.content,
         mem.content_hash || contentHash(mem.content), now, reason);
  db.prepare('DELETE FROM memories_fts WHERE rowid=?').run(mem.id);
  db.prepare('DELETE FROM memories WHERE id=?').run(mem.id);
}

// Inserts or updates one memory row (and its FTS row) from file content. Returns
// the row to embed, or null when nothing about its embedded text changed.
export function upsertMemory(db, { project, sourceId, filename, content, existing = null, now }) {
  const type = memoryType(filename, content);
  const title = extractTitle(content, filename);
  const hash = embedHash(title, content);
  const cHash = contentHash(content);
  if (!existing) {
    const { id } = db.prepare(`
      INSERT INTO memories (project_id, source_id, filename, memory_type, title, content, content_hash, embed_hash, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).get(project.id, sourceId, filename, type, title, content, cHash, hash, now);
    db.prepare('INSERT INTO memories_fts (rowid, title, content, project_name, memory_type) VALUES (?, ?, ?, ?, ?)')
      .run(id, title, content, project.name, type);
    // A file that comes back supersedes any tombstone left by its earlier removal.
    db.prepare('DELETE FROM memory_tombstones WHERE project_id=? AND filename=?').run(project.id, filename);
    return { kind: 'added', mem: { id, title, content, embed_hash: hash } };
  }
  if (existing.content !== content || existing.filename !== filename) {
    db.prepare(`UPDATE memories SET source_id=?, filename=?, memory_type=?, title=?, content=?, content_hash=?, embed_hash=?, synced_at=? WHERE id=?`)
      .run(sourceId, filename, type, title, content, cHash, hash, now, existing.id);
    db.prepare('DELETE FROM memories_fts WHERE rowid=?').run(existing.id);
    db.prepare('INSERT INTO memories_fts (rowid, title, content, project_name, memory_type) VALUES (?, ?, ?, ?, ?)')
      .run(existing.id, title, content, project.name, type);
    const changed = existing.embed_hash !== hash;
    return { kind: existing.content !== content ? 'updated' : 'renamed', mem: changed ? { id: existing.id, title, content, embed_hash: hash } : null };
  }
  // Same content. Re-classify if the title/type rules moved on, and repair a stored
  // hash that disagrees with its own content — the title is part of every chunk's
  // embed text, so a retitle must put the memory back in the backlog.
  if (existing.source_id !== sourceId || existing.memory_type !== type || existing.title !== title ||
      existing.embed_hash !== hash || existing.content_hash !== cHash) {
    db.prepare('UPDATE memories SET source_id=?, memory_type=?, title=?, embed_hash=?, content_hash=? WHERE id=?')
      .run(sourceId, type, title, hash, cHash, existing.id);
  }
  return { kind: 'unchanged', mem: null };
}

// Reconciles one readable source folder with the index.
function reconcile(db, { project, source, files, now, stats, toEmbed }) {
  const owned = db.prepare('SELECT * FROM memories WHERE source_id=?').all(source.id);
  const ownedByName = new Map(owned.map(r => [r.filename, r]));
  const fileNames = new Set(files.map(f => f.filename));
  const live = db.prepare('SELECT * FROM memories WHERE project_id=? AND filename=?');

  const newFiles = [];
  for (const f of files) {
    let existing = ownedByName.get(f.filename);
    if (!existing) {
      const other = live.get(project.id, f.filename);
      if (other && other.source_id != null && other.source_id !== source.id) {
        // The same filename under two sources of one project. The first owner
        // keeps it; an identical copy is just a duplicate, a different one is a
        // conflict worth reporting.
        if (other.content_hash !== f.contentHash) stats.conflicts.push(`${project.name}/${f.filename}`);
        continue;
      }
      // A row no source has claimed yet (indexed before sources existed, or whose
      // folder was lost) is claimed by the first folder that holds its file.
      if (other) existing = other;
    }
    if (existing) {
      const r = upsertMemory(db, { project, sourceId: source.id, filename: f.filename, content: f.content, existing, now });
      stats[r.kind === 'renamed' ? 'unchanged' : r.kind]++;
      if (r.mem) toEmbed.push(r.mem);
    } else {
      newFiles.push(f);
    }
  }

  // Owned rows whose file is gone. A gone row whose exact content reappears under a
  // new name is a rename: keep the row (and its vectors), change the filename.
  const gone = owned.filter(r => !fileNames.has(r.filename));
  for (const r of [...gone]) {
    const i = newFiles.findIndex(f => f.contentHash === (r.content_hash || contentHash(r.content)));
    if (i === -1) continue;
    const [f] = newFiles.splice(i, 1);
    gone.splice(gone.indexOf(r), 1);
    const res = upsertMemory(db, { project, sourceId: source.id, filename: f.filename, content: f.content, existing: r, now });
    if (res.mem) toEmbed.push(res.mem);
    stats.renamed++;
  }

  for (const f of newFiles) {
    const r = upsertMemory(db, { project, sourceId: source.id, filename: f.filename, content: f.content, now });
    stats.added++;
    toEmbed.push(r.mem);
  }

  if (!gone.length) return { status: 'ok', note: null };
  if (gone.length > MASS_MIN && gone.length / owned.length > MASS_SHARE) {
    stats.held += gone.length;
    return { status: 'suspect', note: `${gone.length} of ${owned.length} memory files disappeared in one scan — held until confirmed` };
  }
  for (const r of gone) tombstone(db, r, 'file removed from its source folder', now);
  stats.tombstoned += gone.length;
  return { status: 'ok', note: null };
}

// Project metadata, highest precedence first:
//   1. the project's own MemoryCentral block (or legacy `## Stack`), and a stack
//      override set by the user
//   2. what an AI tool set with set_project_info
//   3. optional Ollama extraction (extract.js) — only when the user enabled it, and
//      only re-run when the project's memories changed
//   4. what is already stored (including pre-2026-10-09 extractions)
//   5. the opening paragraph of the README / instructions file
// A guess never overwrites a deliberate value; meta_source records which won.
async function refreshProjectMeta(db, project, extract) {
  const overrides = getSetting(db, 'stack.overrides', {});
  const declared = readProjectMeta(project.repo_path);
  let description = project.description || '';
  let source = project.meta_source || (description ? 'legacy' : null);
  let stack = JSON.parse(project.stack || '[]');
  let metaHash = project.meta_hash;

  if (declared?.description) {
    description = declared.description;
    source = 'block';
  } else if (source === 'block') {
    source = null; // the block was removed: fall through to the next best
  }

  const wantsAuto = extract.enabled && source !== 'block' && source !== 'agent';
  if (wantsAuto) {
    const memories = db.prepare('SELECT title, memory_type, content FROM memories WHERE project_id=? ORDER BY filename').all(project.id);
    const corpus = memories.length ? projectDigest(project.name, memories, project.repo_path ? fallbackDescription(project.repo_path) : null) : '';
    const hash = createHash('sha256').update(corpus).digest('hex').slice(0, 16);
    if (corpus && (hash !== project.meta_hash || source !== 'auto')) {
      const meta = await extractProjectMeta(corpus, extract);
      if (meta) {
        description = meta.description;
        source = 'auto';
        metaHash = hash;
        if (!declared?.stack && !overrides[project.name] && meta.stack.length) stack = meta.stack;
      }
    }
  }

  // README-derived text is cheap to recompute, so it is refreshed every sync rather
  // than frozen at whatever an earlier version of the fallback produced.
  if ((!description || source === 'readme') && project.repo_path) {
    description = fallbackDescription(project.repo_path) || '';
    source = description ? 'readme' : null;
  }
  if (overrides[project.name]) stack = overrides[project.name];
  else if (declared?.stack) stack = declared.stack;

  db.prepare('UPDATE projects SET description=?, stack=?, meta_file=?, meta_source=?, meta_hash=? WHERE id=?')
    .run(description, JSON.stringify(stack), declared?.file || null, source, metaHash ?? null, project.id);
}

function writeGenerated(db) {
  const root = generatedDir();
  const snapshots = join(root, 'snapshots');
  mkdirSync(snapshots, { recursive: true });
  const projects = db.prepare(`
    SELECT p.*, COUNT(m.id) AS mem_count FROM projects p
    LEFT JOIN memories m ON m.project_id = p.id GROUP BY p.id ORDER BY p.name
  `).all();

  const memsOf = db.prepare('SELECT filename, memory_type, title FROM memories WHERE project_id=? ORDER BY memory_type, filename');
  for (const p of projects) {
    const stack = JSON.parse(p.stack || '[]');
    writeFileSync(join(snapshots, `${safeDirName(p.name)}.md`), [
      `# ${p.name}`, '',
      `**Description:** ${p.description || '_unknown_'}`,
      `**Stack:** ${stack.length ? stack.join(', ') : '_unknown_'}`,
      `**Last synced:** ${p.last_synced}`, '',
      '## Memories', '',
      ...memsOf.all(p.id).map(m => `- \`${m.filename}\` — [${m.memory_type}] ${m.title}`),
    ].join('\n') + '\n');
  }

  const byStack = {};
  for (const p of projects) (byStack[JSON.parse(p.stack || '[]')[0] || 'other'] ??= []).push(p);
  const lines = ['# MemoryCentral Dashboard', '', `_Last synced: ${new Date().toUTCString()}_`, ''];
  for (const [tag, projs] of Object.entries(byStack).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${tag}`, '');
    for (const p of projs) {
      lines.push(`### ${p.name}`);
      if (p.description) lines.push(p.description);
      lines.push(`_Stack: ${JSON.parse(p.stack || '[]').join(', ') || 'unknown'} | ${p.mem_count} memories | synced: ${p.last_synced}_`, '');
    }
  }
  lines.push('---', `_${projects.length} projects tracked_`);
  writeFileSync(join(root, 'DASHBOARD.md'), lines.join('\n') + '\n');
}

// Runs one full sync. Returns a stats object; { skipped: 'busy' } if another process
// holds the sync lease. `embed: false` indexes without vectors (tests, offline runs).
export async function syncAll(db, { onProgress = () => {}, embed = true, holder = `pid-${process.pid}`, now = new Date().toISOString() } = {}) {
  if (!acquireLease(db, 'sync', holder, LEASE_MS)) return { skipped: 'busy' };
  try {
    return await runSync(db, { onProgress, embed, now });
  } finally {
    releaseLease(db, 'sync', holder);
  }
}

async function runSync(db, { onProgress, embed, now }) {
  const stats = {
    projects: 0, added: 0, updated: 0, unchanged: 0, renamed: 0, tombstoned: 0, held: 0,
    unavailable: [], missing: [], conflicts: [], adapterErrors: [], purged: 0, pending: 0, embedReason: null,
  };
  const toEmbed = [];
  importRcOnce(db, { ensureProject: name => ensureProject(db, name, { kind: 'dir', now }) });

  // 1. Discover. A kind whose discovery throws is unavailable as a whole: none of
  //    its known sources can be judged missing this run.
  const found = [];
  const adapterOk = {};
  for (const [kind, adapter] of Object.entries(ADAPTERS)) {
    try {
      for (const d of adapter.discover(db)) {
        // A block's `Project:` line names the project, overriding the folder-derived
        // name — the way two repos that are both called "app" are told apart.
        const declared = d.repoPath ? readProjectMeta(d.repoPath)?.project : null;
        found.push({ kind, ...d, project: declared || d.project });
      }
      adapterOk[kind] = true;
    } catch (err) {
      adapterOk[kind] = false;
      stats.adapterErrors.push(`${adapter.label}: ${err.message}`);
    }
  }

  // 2. Read and reconcile each folder.
  const seen = new Set();
  const touched = new Map();
  const setStatus = db.prepare(`UPDATE sources SET status=?, note=?, last_scan_at=?, last_ok_at=COALESCE(?, last_ok_at), missing_since=? WHERE id=?`);
  const findSource = db.prepare('SELECT * FROM sources WHERE kind=? AND root=?');
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    onProgress({ phase: 'scan', i: i + 1, n: found.length, project: f.project });
    let files;
    try {
      files = scanSource(f.root);
    } catch (err) {
      const known = findSource.get(f.kind, f.root);
      if (known) {
        seen.add(known.id);
        setStatus.run('unavailable', err.message, now, null, known.missing_since, known.id);
      }
      stats.unavailable.push(`${f.project} (${f.kind}): ${err.code || err.message}`);
      continue;
    }
    let source = findSource.get(f.kind, f.root);
    if (!source && !files.length) continue; // an empty folder we have never indexed: nothing to add

    db.exec('BEGIN');
    try {
      const project = ensureProject(db, f.project, { repoPath: f.repoPath, kind: f.kind, now });
      db.prepare('UPDATE projects SET last_synced=? WHERE id=?').run(now, project.id);
      source = ensureSource(db, project.id, f.kind, f.root);
      seen.add(source.id);
      const result = reconcile(db, { project, source, files, now, stats, toEmbed });
      setStatus.run(result.status, result.note, now, now, null, source.id);
      db.exec('COMMIT');
      touched.set(project.id, project);
    } catch (err) {
      db.exec('ROLLBACK');
      stats.unavailable.push(`${f.project} (${f.kind}): ${err.message}`);
    }
  }

  // 3. Known sources not found this run. If their kind discovered fine, the folder
  //    itself is gone — 'missing'. Their memories stay searchable either way.
  for (const s of db.prepare('SELECT s.*, p.name FROM sources s JOIN projects p ON p.id = s.project_id').all()) {
    if (seen.has(s.id)) continue;
    const status = adapterOk[s.kind] === false ? 'unavailable' : 'missing';
    setStatus.run(status, s.note, now, null, s.missing_since || now, s.id);
    stats[status === 'missing' ? 'missing' : 'unavailable'].push(`${s.name} (${s.kind})`);
  }

  // 4. Purge tombstones past their retention.
  const cutoff = new Date(Date.parse(now) - TOMBSTONE_DAYS * 86_400_000).toISOString();
  stats.purged = Number(db.prepare('DELETE FROM memory_tombstones WHERE deleted_at < ?').run(cutoff).changes);

  // 5. Project metadata from each project's own declaration.
  const extract = extractConfig(db);
  const projects = db.prepare('SELECT * FROM projects').all();
  for (let i = 0; i < projects.length; i++) {
    if (extract.enabled) onProgress({ phase: 'describe', i: i + 1, n: projects.length, project: projects[i].name });
    await refreshProjectMeta(db, projects[i], extract);
  }
  stats.projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;

  // 6. Vectors: changed memories first, then anything older still pending. A failing
  //    provider never blocks the sync — the memory is already in the index and FTS.
  if (embed) {
    let failures = 0;
    for (let i = 0; i < toEmbed.length && failures < 3; i++) {
      onProgress({ phase: 'embed', i: i + 1, n: toEmbed.length });
      failures = (await embedMemory(db, toEmbed[i])).ok ? 0 : failures + 1;
    }
    const backlog = await drainPending(db, () => {});
    stats.embedReason = backlog.reason ? `${backlog.reason}: ${backlog.message}` : null;
  }
  stats.pending = countPending(db);

  writeGenerated(db);
  db.prepare(`INSERT INTO sync_events (synced_at, projects_synced, files_added, files_updated, files_unchanged) VALUES (?, ?, ?, ?, ?)`)
    .run(now, touched.size, stats.added, stats.updated, stats.unchanged);
  return stats;
}

// Human-readable summary for the CLI and the MCP `sync` tool.
export function formatSyncStats(s) {
  if (s.skipped) return 'Another MemoryCentral process is syncing right now — skipped.';
  const lines = [`Synced: ${s.projects} projects | +${s.added} added | ~${s.updated} updated | ${s.renamed} renamed | ${s.unchanged} unchanged`];
  if (s.tombstoned) lines.push(`Removed from search: ${s.tombstoned} (files deleted from their folders; restorable for ${TOMBSTONE_DAYS} days)`);
  if (s.held) lines.push(`⚠ Held: ${s.held} memories whose files vanished together — nothing removed; confirm or restore on the dashboard`);
  if (s.missing.length) lines.push(`Source folders gone (memories kept): ${s.missing.join(', ')}`);
  if (s.unavailable.length) lines.push(`⚠ Unreadable (nothing removed): ${s.unavailable.join('; ')}`);
  if (s.adapterErrors.length) lines.push(`⚠ ${s.adapterErrors.join('; ')}`);
  if (s.conflicts.length) lines.push(`⚠ Same filename, different content in two folders (first one kept): ${s.conflicts.join(', ')}`);
  if (s.purged) lines.push(`Purged ${s.purged} tombstone(s) older than ${TOMBSTONE_DAYS} days`);
  if (s.pending) lines.push(`⚠ ${s.pending} memorie(s) pending embedding${s.embedReason ? ` — ${s.embedReason}` : ''}. Keyword search is unaffected; vectors backfill automatically.`);
  return lines.join('\n');
}
