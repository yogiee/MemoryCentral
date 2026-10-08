// Shared settings, stored in the index DB.
//
// Every harness starts its own MCP server process, and the dashboard and sync run
// as more. A per-process config read once at startup let a stale process undo a
// change made elsewhere (2026-10-09: an old server's backfill loop would have
// re-embedded the table back to the previous model). Settings now live in the DB
// that all of them share, and readers re-check on a short TTL.
//
// Precedence everywhere: environment variable > DB setting > platform default.
// Values are JSON-encoded so a setting can be a string, number, list or object.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export function getSetting(db, key, fallback = undefined) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setSetting(db, key, value) {
  if (value === undefined || value === null) {
    db.prepare('DELETE FROM settings WHERE key=?').run(key);
    return;
  }
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, JSON.stringify(value), new Date().toISOString());
}

export function allSettings(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings ORDER BY key').all()
    .map(r => { try { return [r.key, JSON.parse(r.value)]; } catch { return [r.key, null]; } }));
}

// ── Cross-process lease ─────────────────────────────────────────────────────
//
// Only one process should run a sync at a time: two concurrent ingests would both
// see the same new files and race to insert them. A lease row with an expiry is
// enough — SQLite serialises the read-modify-write under BEGIN IMMEDIATE, and an
// expired lease (a crashed holder) is simply taken over.

export function acquireLease(db, name, holder, ttlMs) {
  const key = `lease.${name}`;
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = getSetting(db, key);
    if (cur && cur.holder !== holder && cur.expires > now) {
      db.exec('COMMIT');
      return false;
    }
    setSetting(db, key, { holder, expires: now + ttlMs });
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function releaseLease(db, name, holder) {
  const key = `lease.${name}`;
  if (getSetting(db, key)?.holder === holder) setSetting(db, key, null);
}

// ── One-time import of the old config file ──────────────────────────────────
//
// Before 2026-10-09 configuration lived in ~/.memorycentralrc.json:
//   embedProvider   → setting embed.provider
//   stackOverrides  → setting stack.overrides   ({ project: [tags] })
//   extraPaths      → 'dir' sources              ({ project: [folders] })
// Imported once; the file is left in place (other installs may still read it).

export const rcPath = () => process.env.MC_RC_PATH || join(homedir(), '.memorycentralrc.json');

export function importRcOnce(db, { ensureProject }) {
  if (getSetting(db, 'rc.imported_at')) return null;
  const path = rcPath();
  let rc = {};
  if (existsSync(path)) {
    try { rc = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  }
  if (rc.embedProvider === 'ollama' || rc.embedProvider === 'local') setSetting(db, 'embed.provider', rc.embedProvider);
  if (rc.stackOverrides && typeof rc.stackOverrides === 'object') setSetting(db, 'stack.overrides', rc.stackOverrides);
  const addDir = db.prepare(`INSERT OR IGNORE INTO sources (project_id, kind, root) VALUES (?, 'dir', ?)`);
  for (const [name, dirs] of Object.entries(rc.extraPaths || {})) {
    const project = ensureProject(name);
    for (const dir of [].concat(dirs)) addDir.run(project.id, String(dir));
  }
  setSetting(db, 'rc.imported_at', new Date().toISOString());
  return existsSync(path) ? path : null;
}
