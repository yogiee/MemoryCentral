import { existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

// Decode a Claude-encoded directory name back to { name, path }.
//
// Claude Code encodes a project's absolute path by replacing '/' with '-', which
// is lossy: directory names may themselves contain '-', so a single encoding can
// have several valid readings. `-Users-yogi-WORK-tandem-net-inspector` reads as
// both WORK/tandem-net/inspector and WORK/tandem/net-inspector, and only the
// filesystem can say which is real.
//
// A greedy left-to-right walk commits to the first segment that exists and never
// revisits it, so the moment a shorter sibling appears (creating ~/WORK/tandem
// next to ~/WORK/tandem-net) it strands itself on a path that doesn't exist and
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
