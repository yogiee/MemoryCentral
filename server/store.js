// Writes to memories: the operations MCP tools and the dashboard share.
//
// Files stay the source of truth. Every write lands in a file first and the index
// follows, so a later sync re-reads exactly what was written.

import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { ensureProject, ensureSource, upsertMemory, tombstone } from './ingest.js';
import { ensureNativeProject } from './sources.js';
import { embedMemory } from './backlog.js';
import { activeModel } from './embed.js';

// A memory filename is a single safe path segment ending in .md. Rejects anything
// that could address a different folder (separators, `..`) and Claude Code's own
// index file, which is not a memory.
export function validFilename(filename) {
  const f = String(filename ?? '');
  if (!f || f !== basename(f) || /[\\/:*?"<>|\x00-\x1f]/.test(f) || f.includes('..')) return 'filename must be a plain file name (no folders)';
  if (!/\.md$/i.test(f)) return 'filename must end in .md';
  if (f === 'MEMORY.md' || f.startsWith('_')) return `"${f}" is reserved for index files`;
  return null;
}

// Where a save for (project, filename) should go:
//   1. the folder of the existing memory with that name, wherever it lives — an
//      update edits the memory in place, never forks a copy;
//   2. else any of the project's folders that already has that file on disk (the
//      harness wrote it a moment ago and the index hasn't caught up — the "Claude
//      writes its memory file and also calls save_memory" pattern);
//   3. else MemoryCentral's own store for the project.
function targetFor(db, project, filename) {
  const existing = db.prepare(`
    SELECT m.*, s.root, s.kind FROM memories m LEFT JOIN sources s ON s.id = m.source_id
    WHERE m.project_id=? AND m.filename=?
  `).get(project.id, filename);
  if (existing?.root && existsSync(existing.root)) return { root: existing.root, kind: existing.kind, existing };
  for (const s of db.prepare('SELECT * FROM sources WHERE project_id=?').all(project.id)) {
    if (existsSync(join(s.root, filename))) return { root: s.root, kind: s.kind, existing };
  }
  return { root: ensureNativeProject(project.name, project.repo_path), kind: 'native', existing };
}

// Saves a memory for any harness. Creates the project when it is new.
// Returns { ok, path, created, embedded, reason? }.
export async function saveMemory(db, { project: name, filename, content, projectPath = null, embed = true }) {
  const bad = validFilename(filename);
  if (bad) return { ok: false, reason: bad };
  if (!String(name ?? '').trim()) return { ok: false, reason: 'project is required' };
  const now = new Date().toISOString();

  const project = ensureProject(db, name.trim(), { repoPath: projectPath, kind: 'native', now });
  if (projectPath && project.repo_path !== projectPath) db.prepare('UPDATE projects SET repo_path=? WHERE id=?').run(projectPath, project.id);
  const target = targetFor(db, project, filename);
  const path = join(target.root, filename);
  writeFileSync(path, content);

  const source = ensureSource(db, project.id, target.kind, target.root);
  const r = upsertMemory(db, { project, sourceId: source.id, filename, content, existing: target.existing ?? null, now });
  const result = { ok: true, path, created: r.kind === 'added', embedded: true };
  // Re-saving identical content is the obvious retry after a save whose embedding
  // failed, so an unchanged memory without current vectors is embedded anyway
  // (the 2026-08-28 lesson: an early "already up to date" made that retry impossible).
  if (!r.mem && target.existing) {
    const m = db.prepare('SELECT id, title, content, embed_hash FROM memories WHERE id=?').get(target.existing.id);
    const current = db.prepare('SELECT COUNT(*) AS n FROM embeddings WHERE memory_id=? AND model=? AND embed_hash=?')
      .get(m.id, activeModel(), m.embed_hash).n;
    if (!current) r.mem = m;
  }
  result.changed = r.kind !== 'unchanged' || !!r.mem;
  if (embed && r.mem) {
    const e = await embedMemory(db, r.mem);
    if (!e.ok) Object.assign(result, { embedded: false, reason: `${e.reason}: ${e.message}` });
  }
  return result;
}

// An AI tool describing a project it is working in. It knows the project better
// than any extraction could, and it costs nothing — so this beats auto-extraction,
// and only the project's own MemoryCentral block beats it (ingest.js).
// Returns { ok, overriddenBy? } — overriddenBy names the block that will win.
export function setProjectInfo(db, { project: name, description, stack, projectPath = null }) {
  if (!String(name ?? '').trim()) return { ok: false, reason: 'project is required' };
  const desc = String(description ?? '').replace(/\s+/g, ' ').trim();
  if (!desc && !stack?.length) return { ok: false, reason: 'give a description, a stack, or both' };
  const project = ensureProject(db, name.trim(), { repoPath: projectPath, kind: 'native' });
  if (projectPath && project.repo_path !== projectPath) db.prepare('UPDATE projects SET repo_path=? WHERE id=?').run(projectPath, project.id);
  const tags = Array.isArray(stack)
    ? [...new Set(stack.map(t => String(t).toLowerCase().trim()).filter(t => /^[a-z][a-z0-9.@#+_-]{0,23}$/.test(t)))]
    : null;
  db.prepare(`UPDATE projects SET description=COALESCE(?, description), stack=COALESCE(?, stack), meta_source='agent' WHERE id=?`)
    .run(desc || null, tags?.length ? JSON.stringify(tags) : null, project.id);
  const fresh = db.prepare('SELECT meta_file FROM projects WHERE id=?').get(project.id);
  return { ok: true, overriddenBy: fresh.meta_file || null };
}

// Deliberate delete: removes the file and the memory — no tombstone, because the
// caller asked for exactly this. Any earlier tombstone of the same name goes too.
export function deleteMemory(db, { project: name, filename }) {
  const project = db.prepare('SELECT * FROM projects WHERE name=?').get(name);
  if (!project) return { ok: false, reason: `no project named "${name}"` };
  const mem = db.prepare(`
    SELECT m.*, s.root FROM memories m LEFT JOIN sources s ON s.id = m.source_id
    WHERE m.project_id=? AND m.filename=?
  `).get(project.id, filename);
  if (!mem) return { ok: false, reason: `no memory "${filename}" in ${name}` };
  let fileRemoved = false;
  if (mem.root && existsSync(join(mem.root, filename))) {
    unlinkSync(join(mem.root, filename));
    fileRemoved = true;
  }
  db.prepare('DELETE FROM memories_fts WHERE rowid=?').run(mem.id);
  db.prepare('DELETE FROM memories WHERE id=?').run(mem.id);
  db.prepare('DELETE FROM memory_tombstones WHERE project_id=? AND filename=?').run(project.id, filename);
  return { ok: true, fileRemoved };
}

// Brings a tombstoned memory back by rewriting its file: to its original folder if
// that still exists, else to MemoryCentral's own store. Re-indexing the file also
// clears the tombstone (upsertMemory drops tombstones of a returning name).
export async function restoreTombstone(db, id, { embed = true } = {}) {
  const t = db.prepare(`
    SELECT t.*, p.name AS project, p.repo_path, s.root, s.kind FROM memory_tombstones t
    JOIN projects p ON p.id = t.project_id LEFT JOIN sources s ON s.id = t.source_id WHERE t.id=?
  `).get(id);
  if (!t) return { ok: false, reason: 'no such tombstone' };
  if (db.prepare('SELECT 1 FROM memories WHERE project_id=? AND filename=?').get(t.project_id, t.filename)) {
    return { ok: false, reason: `a live memory named "${t.filename}" already exists in ${t.project}` };
  }
  const original = t.root && existsSync(t.root);
  const root = original ? t.root : ensureNativeProject(t.project, t.repo_path);
  const path = join(root, t.filename);
  writeFileSync(path, t.content);
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(t.project_id);
  const source = ensureSource(db, t.project_id, original ? t.kind : 'native', root);
  const r = upsertMemory(db, { project, sourceId: source.id, filename: t.filename, content: t.content, now: new Date().toISOString() });
  const result = { ok: true, path, embedded: true };
  if (embed && r.mem) {
    const e = await embedMemory(db, r.mem);
    if (!e.ok) Object.assign(result, { embedded: false, reason: `${e.reason}: ${e.message}` });
  }
  return result;
}

// A memory no source holds (indexed before sources existed, its file since renamed
// or removed by hand): give it a file again, in MemoryCentral's own store.
export function adoptOrphan(db, id) {
  const m = db.prepare(`
    SELECT m.*, p.name AS project, p.repo_path FROM memories m JOIN projects p ON p.id = m.project_id
    WHERE m.id=? AND m.source_id IS NULL
  `).get(id);
  if (!m) return { ok: false, reason: 'no such memory without a file' };
  if (validFilename(m.filename)) return { ok: false, reason: `"${m.filename}" can't be a memory file — delete it instead` };
  const root = ensureNativeProject(m.project, m.repo_path);
  const path = join(root, m.filename);
  if (existsSync(path)) return { ok: false, reason: `${m.filename} already exists in ${m.project}'s store` };
  writeFileSync(path, m.content);
  db.prepare('UPDATE memories SET source_id=? WHERE id=?').run(ensureSource(db, m.project_id, 'native', root).id, id);
  return { ok: true, path };
}

export function purgeTombstone(db, id) {
  return { ok: Number(db.prepare('DELETE FROM memory_tombstones WHERE id=?').run(id).changes) === 1 };
}

// A source held as 'suspect' after a mass disappearance: the user confirms the
// removals were intended. Rows whose file is still gone are tombstoned.
export function confirmHeldRemovals(db, sourceId) {
  const s = db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
  if (!s) return { ok: false, reason: 'no such source' };
  const now = new Date().toISOString();
  let n = 0;
  for (const m of db.prepare('SELECT * FROM memories WHERE source_id=?').all(sourceId)) {
    if (!existsSync(join(s.root, m.filename))) { tombstone(db, m, 'confirmed removal (held after a mass disappearance)', now); n++; }
  }
  db.prepare(`UPDATE sources SET status='ok', note=NULL WHERE id=?`).run(sourceId);
  return { ok: true, tombstoned: n };
}

// A source whose folder is gone for good: copy its memories into MemoryCentral's
// own store so they exist as files again, then retire the source.
export function adoptSource(db, sourceId) {
  const s = db.prepare('SELECT s.*, p.name, p.repo_path FROM sources s JOIN projects p ON p.id = s.project_id WHERE s.id=?').get(sourceId);
  if (!s) return { ok: false, reason: 'no such source' };
  const root = ensureNativeProject(s.name, s.repo_path);
  const native = ensureSource(db, s.project_id, 'native', root);
  let n = 0;
  for (const m of db.prepare('SELECT * FROM memories WHERE source_id=?').all(sourceId)) {
    const path = join(root, m.filename);
    if (!existsSync(path)) writeFileSync(path, m.content);
    else if (readFileSync(path, 'utf8') !== m.content) continue; // a different file already holds that name
    db.prepare('UPDATE memories SET source_id=? WHERE id=?').run(native.id, m.id);
    n++;
  }
  db.prepare('DELETE FROM sources WHERE id=?').run(sourceId);
  return { ok: true, adopted: n, root };
}

