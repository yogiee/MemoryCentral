import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { embedHash, CHUNK_CHARS } from './chunk.js';
import { EMBED_MAX_CHARS } from './embed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = join(__dirname, '..', 'stats', 'knowledge.db');

export function openDb() {
  mkdirSync(join(__dirname, '..', 'stats'), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA foreign_keys=ON');
  initSchema(db);
  return db;
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
