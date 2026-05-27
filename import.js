#!/usr/bin/env node
// Restore Claude project memories from a backup created by export.js.
// Usage: node import.js <backup-file.json.gz>
//
// SAME MACHINE (reinstall): encoded paths match — all memories restore automatically.
// NEW MACHINE / NEW USER:   memories restore to the same encoded paths. Claude Code
//                           will find them once you open the corresponding projects
//                           from the same absolute paths. Check the manifest printed
//                           below to see what projects are in the backup.
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { gunzipSync } from 'zlib';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const backupFile = process.argv[2];
if (!backupFile) {
  console.error('Usage: node import.js <backup-file.json.gz>');
  process.exit(1);
}
if (!existsSync(backupFile)) {
  console.error(`ERROR: File not found: ${backupFile}`);
  process.exit(1);
}

const CLAUDE_PROJ = join(homedir(), '.claude', 'projects');

let payload;
try {
  payload = JSON.parse(gunzipSync(readFileSync(backupFile)).toString('utf8'));
} catch (err) {
  console.error(`ERROR: Could not read backup file: ${err.message}`);
  process.exit(1);
}

if (payload.version !== 1) {
  console.error(`ERROR: Unsupported backup version: ${payload.version}`);
  process.exit(1);
}

console.log(`Backup from: ${payload.created} (${payload.platform})`);
console.log(`Projects: ${Object.keys(payload.memories).length}\n`);
console.log('Manifest:');
for (const [encoded, name] of Object.entries(payload.manifest)) {
  console.log(`  ${name.padEnd(24)} ← ${encoded}`);
}
console.log();

let restored = 0;
for (const [encodedPath, files] of Object.entries(payload.memories)) {
  const memDir = join(CLAUDE_PROJ, encodedPath, 'memory');
  mkdirSync(memDir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(memDir, filename), content, 'utf8');
    restored++;
  }
  const name = payload.manifest[encodedPath] || encodedPath;
  console.log(`  ✓  ${name} (${Object.keys(files).length} files)`);
}

console.log(`\nRestored ${restored} files across ${Object.keys(payload.memories).length} projects.`);
console.log('Running sync to rebuild the knowledge database...\n');

await import(join(__dirname, 'server', 'sync.js'));

console.log('\n✓  Import complete. Start a new Claude Code session to use the restored memories.');
