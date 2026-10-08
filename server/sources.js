// Where memory files come from.
//
// A source is one folder of markdown memories that belongs to one project. Each
// kind has an adapter that discovers its folders; the ingest step (ingest.js)
// then reads every folder and reconciles it with the index.
//
//   claude   Claude Code's per-project memory folders (~/.claude/projects/*/memory),
//            read in place. The first harness adapter; others follow the same
//            shape once their on-disk formats are confirmed.
//   native   MemoryCentral's own store (<data root>/projects/<dir>/memory). Memories
//            saved through MCP by any harness land here.
//   dir      Any folder of markdown the user registers for a project (the
//            pre-2026-10-09 `extraPaths`).
//
// Discovery failing for a whole kind, or a folder failing to read, must never
// look like "the files are gone": ingest treats both as unavailable and deletes
// nothing. So scanSource() throws on anything it cannot read in full, and
// discover() throws when the kind's root exists but cannot be listed.

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { claudeProjectsRoot, nativeRoot, safeDirName, resolveProject } from './paths.js';
import { contentHash } from './db.js';

// A memory is any .md file in the folder except index files: Claude Code keeps
// a MEMORY.md table of contents beside the memories, and a leading underscore
// is the long-standing convention for "not a memory".
export const isMemoryFile = name => /\.md$/i.test(name) && name !== 'MEMORY.md' && !name.startsWith('_');

// Reads every memory file in a source folder. Throws if the folder or any file
// cannot be read: a partial listing would make the unread files look deleted.
export function scanSource(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter(e => e.isFile() && isMemoryFile(e.name))
    .map(e => {
      const content = readFileSync(join(root, e.name), 'utf8');
      return { filename: e.name, content, contentHash: contentHash(content) };
    });
}

// Native projects keep their real name in project.json because the folder name
// is sanitised for the filesystem (see safeDirName).
const PROJECT_META = 'project.json';

export function nativeProjectRoot(name) {
  return join(nativeRoot(), safeDirName(name), 'memory');
}

// Creates (if needed) the native folder for a project and records its real name
// and, when known, the repository it belongs to.
export function ensureNativeProject(name, repoPath = null) {
  const dir = join(nativeRoot(), safeDirName(name));
  const root = join(dir, 'memory');
  mkdirSync(root, { recursive: true });
  const metaPath = join(dir, PROJECT_META);
  let meta = {};
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch {}
  if (meta.name !== name || (repoPath && meta.repoPath !== repoPath)) {
    writeFileSync(metaPath, JSON.stringify({ ...meta, name, ...(repoPath && { repoPath }) }, null, 2) + '\n');
  }
  return root;
}

export const ADAPTERS = {
  claude: {
    label: 'Claude Code',
    // No ~/.claude/projects at all means Claude Code isn't used here — nothing to
    // discover, not a failure. If it exists but can't be listed, readdirSync throws.
    discover() {
      const root = claudeProjectsRoot();
      if (!existsSync(root)) return [];
      const found = [];
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const memDir = join(root, entry.name, 'memory');
        if (!existsSync(memDir)) continue;
        // Claude encodes a repo's absolute path; it decodes against the home dir
        // (MC_CLAUDE_HOME lets tests stand up a fake home).
        const { name, path } = resolveProject(entry.name, process.env.MC_CLAUDE_HOME || homedir());
        found.push({ project: name, root: memDir, repoPath: path, legacyKey: entry.name });
      }
      return found;
    },
  },

  native: {
    label: 'MemoryCentral',
    discover() {
      const root = nativeRoot();
      if (!existsSync(root)) return [];
      const found = [];
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const memDir = join(root, entry.name, 'memory');
        if (!existsSync(memDir)) continue;
        let meta = {};
        try { meta = JSON.parse(readFileSync(join(root, entry.name, PROJECT_META), 'utf8')); } catch {}
        found.push({ project: meta.name || entry.name, root: memDir, repoPath: meta.repoPath || null });
      }
      return found;
    },
  },

  // Registered folders live only in the sources table, so discovery is a read of
  // it. A registered folder that has vanished still comes back here; scanSource
  // then throws and ingest marks it unavailable.
  dir: {
    label: 'Folder',
    discover(db) {
      return db.prepare(`
        SELECT s.root, p.name AS project, p.repo_path AS repoPath
        FROM sources s JOIN projects p ON p.id = s.project_id WHERE s.kind = 'dir'
      `).all();
    },
  },
};
