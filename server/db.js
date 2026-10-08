import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, linkSync, unlinkSync, renameSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';
import { embedHash, CHUNK_CHARS } from './chunk.js';
import { EMBED_MAX_CHARS } from './embed.js';
import { dbPath, LEGACY_DB_PATH } from './paths.js';

// Opens (creating if needed) the index DB. The path defaults to the data root's
// memorycentral.db; tests pass their own or set MEMORYCENTRAL_HOME.
export function openDb(path = dbPath()) {
  mkdirSync(dirname(path), { recursive: true });
  if (!process.env.MEMORYCENTRAL_HOME && path === dbPath() && existsSync(LEGACY_DB_PATH) && isEmptyIndex(path)) {
    moveLegacyDb(path);
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA foreign_keys=ON');
  initSchema(db);
  return db;
}

// Turns what a person (or an agent) types into a safe FTS5 query. Raw input is FTS5
// syntax: `Cache-Control` parses as a column filter and errors, `don't` breaks on
// the quote. Each plain token becomes a quoted phrase (FTS still tokenises inside
// it, so `Cache-Control` matches "cache control"); deliberate syntax is kept —
// quoted phrases, the AND/OR/NOT/NEAR operators, and prefix terms like `embed*`.
export function ftsQuery(input) {
  const tokens = String(input).match(/"[^"]*"|\S+/g) || [];
  return tokens.map(t => {
    if (/^".*"$/.test(t) || /^(AND|OR|NOT|NEAR)$/.test(t) || /^[\p{L}\p{N}_]+\*$/u.test(t)) return t;
    return `"${t.replace(/"/g, '""')}"`;
  }).join(' ');
}

export const contentHash = content => createHash('sha256').update(String(content)).digest('hex').slice(0, 32);

// One-time move of the pre-2026-10-09 DB from <clone>/stats/knowledge.db into the
// data root. Only for the DEFAULT root: a custom MEMORYCENTRAL_HOME (tests, a second
// install) starts empty instead of silently cloning someone's real index.
//
// VACUUM INTO gives a consistent snapshot even while an old-code MCP server still
// has the legacy file open (it reads through the WAL). The copy lands in a temp
// file and is hard-linked into place, which fails rather than overwrites if another
// process — every harness starts its own server — won the race. The legacy file is
// left untouched as the backup.
// True when there is no index at `path`, or one with no projects in it. An empty
// index must never shadow a populated legacy one: anything that opened the default
// path before the move (a stray script, a half-finished first run) would otherwise
// leave every memory looking gone.
function isEmptyIndex(path) {
  if (!existsSync(path)) return true;
  try {
    const db = new DatabaseSync(path);
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get();
    const n = has ? db.prepare('SELECT COUNT(*) AS n FROM projects').get().n : 0;
    db.close();
    return n === 0;
  } catch {
    return false; // unreadable: leave it alone rather than replace it
  }
}

function moveLegacyDb(path) {
  const tmp = `${path}.migrating-${process.pid}`;
  try {
    const legacy = new DatabaseSync(LEGACY_DB_PATH);
    legacy.exec('PRAGMA busy_timeout=5000');
    legacy.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    legacy.close();
    // An empty index in the way is set aside (never deleted) before the link.
    if (existsSync(path)) renameSync(path, `${path}.empty-${Date.now()}`);
    for (const ext of ['-wal', '-shm']) if (existsSync(path + ext)) renameSync(path + ext, `${path}${ext}.empty-${Date.now()}`);
    try { linkSync(tmp, path); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    process.stderr.write(`memoryCentral: moved the index from ${LEGACY_DB_PATH} to ${path} (the old file is kept as a backup)\n`);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id           INTEGER PRIMARY KEY,
      name         TEXT    UNIQUE NOT NULL,
      encoded_path TEXT    UNIQUE NOT NULL,
      description  TEXT    DEFAULT '',
      stack        TEXT    DEFAULT '[]',
      last_synced  TEXT,
      meta_hash    TEXT
    );

    CREATE TABLE IF NOT EXISTS memories (
      id           INTEGER PRIMARY KEY,
      project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      filename     TEXT    NOT NULL,
      memory_type  TEXT    DEFAULT 'general',
      title        TEXT    DEFAULT '',
      content      TEXT    NOT NULL,
      embed_hash   TEXT    DEFAULT '',
      synced_at    TEXT    NOT NULL,
      UNIQUE(project_id, filename)
    );

    -- Standalone FTS5 table — supports normal DELETE/INSERT for updates
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title,
      content,
      project_name UNINDEXED,
      memory_type  UNINDEXED
    );

    -- One row per CHUNK, not per memory (see chunk.js). A long memory is several
    -- vectors; find_similar collapses them back to one hit per memory.
    CREATE TABLE IF NOT EXISTS embeddings (
      memory_id    INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      chunk_index  INTEGER NOT NULL,
      start_char   INTEGER NOT NULL,
      end_char     INTEGER NOT NULL,
      vector       TEXT    NOT NULL,
      model        TEXT    NOT NULL,
      embed_hash   TEXT    NOT NULL,
      generated_at TEXT    NOT NULL,
      PRIMARY KEY (memory_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);

    CREATE TABLE IF NOT EXISTS sync_events (
      id               INTEGER PRIMARY KEY,
      synced_at        TEXT    NOT NULL,
      projects_synced  INTEGER DEFAULT 0,
      files_added      INTEGER DEFAULT 0,
      files_updated    INTEGER DEFAULT 0,
      files_unchanged  INTEGER DEFAULT 0
    );
  `);

  // Migration for DBs created before 2026-07-10: content hash that gates
  // description re-extraction (see sync.js). No-op once the column exists.
  try { db.exec('ALTER TABLE projects ADD COLUMN meta_hash TEXT'); } catch {}

  // Migration for DBs created before 2026-08-28: hash of the exact text each
  // memory's vectors were built from. Backfilled by migrateToChunkedEmbeddings.
  try { db.exec("ALTER TABLE memories ADD COLUMN embed_hash TEXT DEFAULT ''"); } catch {}

  migrateToChunkedEmbeddings(db);
  migrateToSources(db);
}

// Schema v2 (2026-10-09): MemoryCentral stops being a mirror of one harness's folders.
//
//   settings           shared configuration — every process (each harness's MCP
//                      server, the dashboard, sync) reads the same values
//   sources            where a project's memory files come from: a harness folder
//                      read in place ('claude'), MemoryCentral's own store
//                      ('native'), or any folder of markdown ('dir')
//   memories.source_id which source owns the file; NULL = no source has claimed it
//                      (its file is gone or was never found) — kept, never deleted
//   memory_tombstones  memories whose file was deliberately removed; hidden from
//                      every query because they are no longer in `memories`,
//                      restorable until purged
//
// Rows are not assigned to sources here: the first sync claims each one when it
// finds the file. That keeps this migration free of filesystem access, and a row
// whose file is never found simply stays an orphan rather than being guessed at.
function migrateToSources(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 2) return;
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sources (
        id            INTEGER PRIMARY KEY,
        project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind          TEXT    NOT NULL,
        root          TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'ok',
        last_scan_at  TEXT,
        last_ok_at    TEXT,
        missing_since TEXT,
        note          TEXT,
        UNIQUE(kind, root)
      );

      CREATE TABLE IF NOT EXISTS memory_tombstones (
        id           INTEGER PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_id    INTEGER,
        filename     TEXT    NOT NULL,
        title        TEXT    DEFAULT '',
        memory_type  TEXT    DEFAULT 'general',
        content      TEXT    NOT NULL,
        content_hash TEXT    NOT NULL,
        deleted_at   TEXT    NOT NULL,
        reason       TEXT    NOT NULL
      );
    `);
    const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('memories')").all().map(c => c.name));
    if (!cols.has('source_id')) db.exec('ALTER TABLE memories ADD COLUMN source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL');
    if (!cols.has('content_hash')) db.exec("ALTER TABLE memories ADD COLUMN content_hash TEXT DEFAULT ''");
    const pcols = new Set(db.prepare("SELECT name FROM pragma_table_info('projects')").all().map(c => c.name));
    if (!pcols.has('repo_path')) db.exec('ALTER TABLE projects ADD COLUMN repo_path TEXT');
    // Which instructions file carried the project's MemoryCentral block (NULL = none).
    if (!pcols.has('meta_file')) db.exec('ALTER TABLE projects ADD COLUMN meta_file TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash)');

    const setHash = db.prepare('UPDATE memories SET content_hash=? WHERE id=?');
    for (const m of db.prepare('SELECT id, content FROM memories').all()) setHash.run(contentHash(m.content), m.id);

    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Migration for DBs created before 2026-08-28: one vector per memory -> one per
// chunk. SQLite cannot widen a PRIMARY KEY in place, so the table is rebuilt.
//
// Every existing vector carries over as chunk 0 and stays searchable. What a
// memory long enough to be chunked does NOT get is a matching embed_hash —
// claiming one vector covers content that now maps to several would preserve the
// blind spot chunking removes, and for anything past EMBED_MAX_CHARS that vector
// never saw the tail of the memory at all. Those rows keep an empty hash, which
// no real hash can equal, so they land in the backlog and are re-chunked on the
// next drain. Short memories are already exactly what chunkMemory would produce
// and are marked current, so the drain stays small.
// A memory whose single legacy vector no longer represents how it would be
// embedded today. Anything past CHUNK_CHARS now maps to more than one vector.
const willChunk = content => content.length > CHUNK_CHARS;

function migrateToChunkedEmbeddings(db) {
  const chunked = db.prepare(
    "SELECT COUNT(*) AS n FROM pragma_table_info('embeddings') WHERE name='chunk_index'"
  ).get().n;
  if (chunked) return;

  const legacy = db.prepare('SELECT memory_id, vector, model, generated_at FROM embeddings').all();
  const memories = db.prepare('SELECT id, title, content FROM memories').all();
  const byId = new Map(memories.map(m => [m.id, m]));

  db.exec('BEGIN');
  try {
    db.exec('DROP TABLE embeddings');
    db.exec(`
      CREATE TABLE embeddings (
        memory_id    INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        chunk_index  INTEGER NOT NULL,
        start_char   INTEGER NOT NULL,
        end_char     INTEGER NOT NULL,
        vector       TEXT    NOT NULL,
        model        TEXT    NOT NULL,
        embed_hash   TEXT    NOT NULL,
        generated_at TEXT    NOT NULL,
        PRIMARY KEY (memory_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);
    `);

    const ins = db.prepare(`
      INSERT INTO embeddings (memory_id, chunk_index, start_char, end_char, vector, model, embed_hash, generated_at)
      VALUES (?, 0, 0, ?, ?, ?, ?, ?)
    `);
    for (const row of legacy) {
      const mem = byId.get(row.memory_id);
      if (!mem) continue; // orphaned vector; the rebuild is a good time to drop it
      ins.run(
        row.memory_id,
        Math.min(mem.content.length, EMBED_MAX_CHARS),
        row.vector,
        row.model,
        willChunk(mem.content) ? '' : embedHash(mem.title, mem.content),
        row.generated_at,
      );
    }

    const setHash = db.prepare('UPDATE memories SET embed_hash=? WHERE id=?');
    for (const m of memories) setHash.run(embedHash(m.title, m.content), m.id);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const rechunk = memories.filter(m => willChunk(m.content)).length;
  process.stderr.write(
    `memoryCentral: migrated ${legacy.length} vector(s) to chunked embeddings` +
    `${rechunk ? ` — ${rechunk} truncated memorie(s) queued for re-chunking` : ''}\n`
  );
}
