import { existsSync, readdirSync, statSync } from 'fs';
import { join, basename, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// ── Where MemoryCentral keeps its own data ──────────────────────────────────
//
// Everything MemoryCentral owns lives under one per-user data root, independent
// of where the repo is cloned:
//
//   ~/.memorycentral/
//     memorycentral.db            index: memories, FTS, vectors, settings, sources
//     projects/<dir>/memory/*.md  memories MemoryCentral owns (saved through MCP)
//     projects/<dir>/project.json the project's real name (dir names are sanitised)
//     generated/                  snapshots + DASHBOARD.md, rebuilt every sync
//     backups/                    safety copies taken before migrations
//
// Harness memories (Claude Code's ~/.claude/projects/*/memory today) are NOT
// copied here: they are sources, read in place and fully ingested into the DB.
//
// Every path is a function read at call time, so MEMORYCENTRAL_HOME and
// MC_CLAUDE_PROJECTS set by a test (or a second install) take effect without
// reloading modules.
export const dataRoot = () => resolve(process.env.MEMORYCENTRAL_HOME || join(homedir(), '.memorycentral'));
export const dbPath = () => join(dataRoot(), 'memorycentral.db');
export const nativeRoot = () => join(dataRoot(), 'projects');
export const generatedDir = () => join(dataRoot(), 'generated');
export const backupsDir = () => join(dataRoot(), 'backups');
export const claudeProjectsRoot = () => resolve(process.env.MC_CLAUDE_PROJECTS || join(homedir(), '.claude', 'projects'));

// Before 2026-10-09 the DB lived inside the clone. openDb() moves it once.
export const LEGACY_DB_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'stats', 'knowledge.db');

// A project name made safe as a single directory name on every platform. Windows
// rejects <>:"/\|?* and control characters, trailing dots/spaces, and a set of
// reserved device names (CON, NUL, COM1…) regardless of extension. The real name
// is kept in project.json beside it, so this mapping never has to be reversed.
export function safeDirName(name) {
  let s = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s || s === '.' || s === '..') s = '_';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  return s.slice(0, 120);
}

// Decode a Claude-encoded directory name back to { name, path }.
//
// Claude Code names a project's folder after its absolute path with EVERY
// non-alphanumeric character replaced by '-': '/Users/me/my_app.v2' becomes
// '-Users-me-my-app-v2', and on Windows 'C:\\Users\\Dev\\proj' becomes
// 'C--Users-Dev-proj'. That is lossy — a '-' may have been a separator, a hyphen,
// a dot, an underscore or a space — so only the filesystem can say which reading
// is real. Before 2026-10-09 this decoder assumed only separators had been
// replaced, which failed on every Windows path and on any folder name with a dot,
// underscore or space.
//
// The walk matches the encoded string against real directory entries, encoding
// each entry the same way, and backtracks when a branch dead-ends (a sibling
// `foo` next to `foo-bar` must not strand it). It starts at the home directory,
// else at the filesystem root the encoding names ('/' on POSIX, the drive on
// Windows).
//
// path is null when nothing on disk matches — callers must guard before reading
// it. `home` is injectable so tests can build fixtures in a tmpdir.
export const encodeClaudePath = p => String(p).replace(/[^a-zA-Z0-9]/g, '-');

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// Depth-first match of encoded[pos..] against the directory tree under `dir`.
// Returns the deepest full match, or { partial } — the deepest directory reached
// and where in the string it stopped — for the missing-leaf fallback.
function walk(dir, encoded, pos) {
  if (pos >= encoded.length) return { path: dir };
  let entries;
  try { entries = readdirSync(dir); } catch { entries = []; }
  // Shortest entry first, so unambiguous paths resolve exactly as a greedy walk.
  const candidates = entries
    .map(e => ({ e, enc: encodeClaudePath(e) }))
    .filter(({ enc }) => enc && encoded.startsWith(enc, pos) &&
      (pos + enc.length === encoded.length || encoded[pos + enc.length] === '-'))
    .sort((a, b) => a.enc.length - b.enc.length);
  let best = { partial: { dir, pos } };
  for (const { e, enc } of candidates) {
    const next = join(dir, e);
    if (!isDir(next)) continue;
    const r = walk(next, encoded, pos + enc.length + 1);
    if (r.path) return r;
    if (r.partial.pos > best.partial.pos) best = r;
  }
  return best;
}

export function resolveProject(encoded, home = homedir()) {
  const homeEnc = encodeClaudePath(home);
  if (encoded === homeEnc) return { name: 'home', path: home };

  let start = null;
  if (encoded.startsWith(homeEnc + '-')) start = { dir: home, pos: homeEnc.length + 1 };
  else if (/^[A-Za-z]--/.test(encoded) && process.platform === 'win32') start = { dir: `${encoded[0]}:\\`, pos: 3 };
  else if (encoded.startsWith('-') && process.platform !== 'win32') start = { dir: '/', pos: 1 };

  if (start) {
    const r = walk(start.dir, encoded, start.pos);
    if (r.path) return { name: basename(r.path), path: r.path };
    // The project folder was moved or deleted, but its memories remain. Keep a
    // stable name so the existing project row still matches on the next sync:
    // under the home dir, the unmatched tail; elsewhere, the whole encoding.
    if (start.dir === home) {
      const tail = encoded.slice(r.partial.pos).replace(/^-+/, '');
      return { name: tail || basename(r.partial.dir), path: null };
    }
  }
  return { name: encoded.replace(/^-+/, ''), path: null };
}

// Name-only convenience for callers that don't need the resolved path.
export function resolveProjectName(encoded, home = homedir()) {
  return resolveProject(encoded, home).name;
}
