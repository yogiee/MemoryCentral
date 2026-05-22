import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
      last_synced  TEXT
    );

    CREATE TABLE IF NOT EXISTS memories (
      id           INTEGER PRIMARY KEY,
      project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      filename     TEXT    NOT NULL,
      memory_type  TEXT    DEFAULT 'general',
      title        TEXT    DEFAULT '',
      content      TEXT    NOT NULL,
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

    CREATE TABLE IF NOT EXISTS embeddings (
      memory_id    INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      vector       TEXT    NOT NULL,
      model        TEXT    NOT NULL,
      generated_at TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_events (
      id               INTEGER PRIMARY KEY,
      synced_at        TEXT    NOT NULL,
      projects_synced  INTEGER DEFAULT 0,
      files_added      INTEGER DEFAULT 0,
      files_updated    INTEGER DEFAULT 0,
      files_unchanged  INTEGER DEFAULT 0
    );
  `);
}
