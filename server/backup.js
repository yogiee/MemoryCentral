// Backup and restore of everything MemoryCentral knows.
//
// A backup is taken from the index, not from one harness's folders, so it carries
// every memory whatever its source — including memories whose source folder is
// already gone, which exist nowhere else. Restoring puts each file back where it
// came from when that folder exists on this machine, and into MemoryCentral's own
// store otherwise; a sync then rebuilds the index from the files.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ensureProject, ensureSource } from './ingest.js';
import { ensureNativeProject } from './sources.js';
import { getSetting, setSetting, allSettings } from './settings.js';
import { claudeProjectsRoot } from './paths.js';

export const BACKUP_VERSION = 2;

// Machine-local or transient settings are not carried to another machine.
const LOCAL_SETTING = /^(lease\.|rc\.imported_at$|setup\.)/;

export function exportBackup(db) {
  const projects = db.prepare('SELECT id, name, description, stack, repo_path FROM projects ORDER BY name').all();
  const nameOf = new Map(projects.map(p => [p.id, p.name]));
  return {
    version: BACKUP_VERSION,
    created: new Date().toISOString(),
    platform: process.platform,
    projects: projects.map(({ id, ...p }) => ({ ...p, stack: JSON.parse(p.stack || '[]') })),
    sources: db.prepare('SELECT project_id, kind, root FROM sources').all()
      .map(s => ({ project: nameOf.get(s.project_id), kind: s.kind, root: s.root })),
    memories: db.prepare(`
      SELECT m.project_id, m.filename, m.content, s.kind, s.root FROM memories m
      LEFT JOIN sources s ON s.id = m.source_id ORDER BY m.project_id, m.filename
    `).all().map(m => ({ project: nameOf.get(m.project_id), filename: m.filename, content: m.content, kind: m.kind, root: m.root })),
    tombstones: db.prepare('SELECT project_id, filename, title, memory_type, content, content_hash, deleted_at, reason FROM memory_tombstones').all()
      .map(({ project_id, ...t }) => ({ project: nameOf.get(project_id), ...t })),
    settings: Object.fromEntries(Object.entries(allSettings(db)).filter(([k]) => !LOCAL_SETTING.test(k))),
  };
}

// Writes the files a backup describes. Returns counts; the caller runs a sync.
// An existing file with the same name is this machine's current truth and is kept.
export function importBackup(db, payload) {
  if (payload.version === 1) return importV1(payload);
  if (payload.version !== BACKUP_VERSION) throw new Error(`unsupported backup version ${payload.version}`);
  const result = { restored: 0, keptExisting: 0, toStore: 0 };

  for (const p of payload.projects) {
    const project = ensureProject(db, p.name, { repoPath: p.repo_path && existsSync(p.repo_path) ? p.repo_path : null });
    if (!project.description && p.description) {
      db.prepare('UPDATE projects SET description=?, stack=? WHERE id=?').run(p.description, JSON.stringify(p.stack || []), project.id);
    }
  }
  // Registered folders come back only if they exist here.
  for (const s of payload.sources) {
    if (s.kind === 'dir' && existsSync(s.root)) ensureSource(db, ensureProject(db, s.project).id, 'dir', s.root);
  }
  for (const m of payload.memories) {
    const home = m.kind && m.kind !== 'native' && m.root && existsSync(m.root);
    const root = home ? m.root : ensureNativeProject(m.project);
    if (!home) result.toStore++;
    const path = join(root, m.filename);
    if (existsSync(path)) { result.keptExisting++; continue; }
    writeFileSync(path, m.content);
    result.restored++;
  }
  const insTomb = db.prepare(`
    INSERT INTO memory_tombstones (project_id, filename, title, memory_type, content, content_hash, deleted_at, reason)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM memory_tombstones WHERE project_id=? AND filename=?)
  `);
  for (const t of payload.tombstones || []) {
    const pid = ensureProject(db, t.project).id;
    insTomb.run(pid, t.filename, t.title, t.memory_type, t.content, t.content_hash, t.deleted_at, t.reason, pid, t.filename);
  }
  for (const [k, v] of Object.entries(payload.settings || {})) {
    if (!LOCAL_SETTING.test(k) && getSetting(db, k) === undefined) setSetting(db, k, v);
  }
  return result;
}

// Pre-2026-10-09 backups held only Claude Code folders, keyed by Claude's encoded
// project path. They go back to the same encoded paths.
function importV1(payload) {
  const result = { restored: 0, keptExisting: 0, toStore: 0 };
  for (const [encoded, files] of Object.entries(payload.memories)) {
    const dir = join(claudeProjectsRoot(), encoded, 'memory');
    mkdirSync(dir, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      const path = join(dir, filename);
      if (existsSync(path)) { result.keptExisting++; continue; }
      writeFileSync(path, content);
      result.restored++;
    }
  }
  return result;
}

export const readBackupFile = (path, gunzip) => JSON.parse(gunzip(readFileSync(path)).toString('utf8'));
