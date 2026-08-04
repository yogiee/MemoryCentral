// Regression tests for the encoded-path decoder.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir, homedir } from 'os';
import { resolveProject } from '../server/paths.js';

// Encode an absolute path the way Claude Code does.
const enc = p => p.replace(/[/\\]/g, '-');

// --- The ambiguity that silently rotted in production -----------------------
// Sibling dirs `foo` and `foo-bar` make `<home>-foo-bar-baz` ambiguous:
//   foo-bar/baz  (real)   vs   foo/bar-baz  (not)
// A greedy walk matches `foo` first, commits, and strands on a phantom path.
test('backtracks past an ambiguous prefix to the segmentation that exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-paths-'));
  try {
    mkdirSync(join(home, 'foo'));                        // the decoy
    mkdirSync(join(home, 'foo-bar', 'baz'), { recursive: true }); // the real one

    const { name, path } = resolveProject(enc(home) + '-foo-bar-baz', home);

    assert.equal(path, join(home, 'foo-bar', 'baz'));
    assert.equal(name, 'baz');
    assert.ok(existsSync(path), 'resolved path must exist on disk');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolves unambiguously when no decoy sibling exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-paths-'));
  try {
    mkdirSync(join(home, 'foo-bar', 'baz'), { recursive: true });
    const { name, path } = resolveProject(enc(home) + '-foo-bar-baz', home);
    assert.equal(path, join(home, 'foo-bar', 'baz'));
    assert.equal(name, 'baz');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('hyphenated leaf directory keeps its full name', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-paths-'));
  try {
    mkdirSync(join(home, 'WORK', 'KODI-Playground'), { recursive: true });
    const { name } = resolveProject(enc(home) + '-WORK-KODI-Playground', home);
    assert.equal(name, 'KODI-Playground');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A deleted/moved project must yield path:null — never a phantom path — while
// keeping the greedy walk's name so the existing DB row still matches on re-sync.
// Mirrors the real cases (~/WORK/PersonalProjects/ALICE): parents still exist,
// only the leaf is gone.
test('missing leaf yields path:null but keeps the project name', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-paths-'));
  try {
    mkdirSync(join(home, 'WORK'));
    const { name, path } = resolveProject(enc(home) + '-WORK-GoneProject', home);
    assert.equal(path, null);
    assert.equal(name, 'GoneProject');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('encodings outside the home dir return path:null', () => {
  const { name, path } = resolveProject('-opt-elsewhere-thing', '/Users/nobody');
  assert.equal(path, null);
  assert.equal(name, 'opt-elsewhere-thing');
});

// --- Invariants across the live corpus --------------------------------------
// These are what actually break sync: a non-existent path feeds bogus names into
// the projects upsert, and duplicate names collide on the UNIQUE constraints.
function liveEncodedDirs() {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .filter(e => existsSync(join(root, e.name, 'memory')))
    .filter(e => readdirSync(join(root, e.name, 'memory'))
      .some(f => f.endsWith('.md') && !f.startsWith('_')))
    .map(e => e.name);
}

test('every live project resolves to an existing path or null', () => {
  for (const encoded of liveEncodedDirs()) {
    const { path } = resolveProject(encoded);
    if (path !== null) {
      assert.ok(existsSync(path), `${encoded} resolved to non-existent ${path}`);
    }
  }
});

test('resolved names are unique across live projects', () => {
  const seen = new Map();
  for (const encoded of liveEncodedDirs()) {
    const { name } = resolveProject(encoded);
    assert.ok(!seen.has(name),
      `name "${name}" claimed by both ${seen.get(name)} and ${encoded} — ` +
      `these collide on projects.name and silently merge`);
    seen.set(name, encoded);
  }
});

test('resolved name matches the resolved path basename', () => {
  for (const encoded of liveEncodedDirs()) {
    const { name, path } = resolveProject(encoded);
    if (path !== null) assert.equal(name, basename(path));
  }
});
