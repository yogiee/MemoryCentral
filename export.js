#!/usr/bin/env node
// Back up everything MemoryCentral knows to one portable file.
// Usage: node export.js [output-file]     (default: memoryCentral-backup-YYYY-MM-DD.json.gz)
//
// Taken from the index, so it covers every memory from every source — AI tools'
// memory folders, MemoryCentral's own store, registered folders — plus projects,
// settings and recently deleted memories (still restorable).
import { writeFileSync } from 'fs';
import { gzipSync } from 'zlib';
import { openDb } from './server/db.js';
import { exportBackup } from './server/backup.js';

const outFile = process.argv[2] || `memoryCentral-backup-${new Date().toISOString().slice(0, 10)}.json.gz`;
const db = openDb();
const payload = exportBackup(db);
db.close();
writeFileSync(outFile, gzipSync(JSON.stringify(payload)));
console.log(`✓  Backup created: ${outFile}`);
console.log(`   ${payload.projects.length} projects, ${payload.memories.length} memories, ${payload.tombstones.length} recently deleted`);
