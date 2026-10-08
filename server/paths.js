import { existsSync } from 'fs';
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
// Claude Code encodes a project's absolute path by replacing '/' with '-', which
// is lossy: directory names may themselves contain '-', so a single encoding can
// have several valid readings. `-Users-yogi-WORK-work-net-client-app` reads as
// both WORK/work-net/client-app and WORK/work/net-client-app, and only the
// filesystem can say which is real.
//
// A greedy left-to-right walk commits to the first segment that exists and never
// revisits it, so the moment a shorter sibling appears (creating ~/WORK/work
// next to ~/WORK/work-net) it strands itself on a path that doesn't exist and
// invents a project name from it. Verify every step and backtrack instead.
//
// path is null when the encoding lies outside the home dir (not reconstructable)
// or when no segmentation exists on disk — callers must guard before reading it.
// `home` is injectable so tests can build ambiguous fixtures in a tmpdir.
export function resolveProject(encoded, home = homedir()) {
  const homeEnc = home.replace(/[/\\]/g, '-');
  if (!encoded.startsWith(homeEnc)) return { name: encoded.replace(/^-/, ''), path: null };
  const rel = encoded.slice(homeEnc.length).replace(/^-/, '');
  if (!rel) return { name: 'home', path: home };
  const tokens = rel.split('-');

  // Depth-first over segmentations, shortest segment first — so unambiguous
  // paths resolve exactly as the old greedy walk did.
  function walk(current, i) {
    if (i === tokens.length) return current;
    let seg = tokens[i];
    for (let j = i; j < tokens.length; j++) {
      if (j > i) seg += '-' + tokens[j];
      const next = join(current, seg);
      if (!existsSync(next)) continue;
      const found = walk(next, j + 1);
      if (found) return found;
    }
    return null;
  }

  const resolved = walk(home, 0);
  if (resolved) return { name: basename(resolved), path: resolved };

  // Nothing on disk matches — the project directory was moved or deleted, but its
  // memories still live under ~/.claude/projects. Fall back to the old greedy
  // walk's NAME so the existing DB row still matches on re-sync, with path:null
  // so callers skip it instead of reading a phantom path.
  let current = home, i = 0;
  while (i < tokens.length) {
    let seg = tokens[i++];
    while (!existsSync(join(current, seg)) && i < tokens.length) seg += '-' + tokens[i++];
    current = join(current, seg);
  }
  return { name: basename(current), path: null };
}

// Name-only convenience for callers that don't need the resolved path.
export function resolveProjectName(encoded, home = homedir()) {
  return resolveProject(encoded, home).name;
}
