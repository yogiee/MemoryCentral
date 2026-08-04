#!/usr/bin/env node
// Export all Claude project memories to a portable gzipped backup.
// Usage: node export.js [output-file]
// Output: memoryCentral-backup-YYYY-MM-DD.json.gz  (default)
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { gzipSync } from 'zlib';
// Shared with sync.js. This file used to take the last hyphen token instead,
// which mislabelled every hyphenated project (KODI-Playground -> "Playground").
import { resolveProjectName } from './server/paths.js';

const CLAUDE_PROJ = join(homedir(), '.claude', 'projects');
const date        = new Date().toISOString().slice(0, 10);
const outFile     = process.argv[2] || `memoryCentral-backup-${date}.json.gz`;

if (!existsSync(CLAUDE_PROJ)) {
  console.error(`ERROR: Claude projects directory not found: ${CLAUDE_PROJ}`);
  process.exit(1);
}

const memories  = {};  // { encodedPath: { filename: content } }
const manifest  = {};  // { encodedPath: humanReadableName }

let fileCount = 0;
for (const entry of readdirSync(CLAUDE_PROJ, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const memDir = join(CLAUDE_PROJ, entry.name, 'memory');
  if (!existsSync(memDir) || !statSync(memDir).isDirectory()) continue;

  const files = readdirSync(memDir).filter(f => f.endsWith('.md'));
  if (!files.length) continue;

  memories[entry.name] = {};
  manifest[entry.name] = resolveProjectName(entry.name);

  for (const file of files) {
    memories[entry.name][file] = readFileSync(join(memDir, file), 'utf8');
    fileCount++;
  }
}

const payload = JSON.stringify({
  version:  1,
  created:  new Date().toISOString(),
  platform: process.platform,
  manifest,
  memories,
}, null, 0);

writeFileSync(outFile, gzipSync(payload));

const kb = (readFileSync(outFile).length / 1024).toFixed(1);
console.log(`✓  Backup created: ${outFile}`);
console.log(`   ${Object.keys(memories).length} projects, ${fileCount} files — ${kb} KB`);
