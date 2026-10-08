#!/usr/bin/env node
// Restore a backup made by export.js (any version), then rebuild the index.
// Usage: node import.js <backup-file.json.gz>
//
// Each memory goes back to the folder it came from if that folder exists on this
// machine, otherwise into MemoryCentral's own store — so nothing in the backup is
// lost on a machine with a different layout. A file already present with the same
// name is kept (it is this machine's current version).
import { existsSync } from 'fs';
import { gunzipSync } from 'zlib';
import { openDb } from './server/db.js';
import { importBackup, readBackupFile } from './server/backup.js';
import { syncAll, formatSyncStats } from './server/ingest.js';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error(file ? `ERROR: File not found: ${file}` : 'Usage: node import.js <backup-file.json.gz>');
  process.exit(1);
}
let payload;
try {
  payload = readBackupFile(file, gunzipSync);
} catch (err) {
  console.error(`ERROR: Could not read backup file: ${err.message}`);
  process.exit(1);
}

const db = openDb();
try {
  console.log(`Backup from ${payload.created} (${payload.platform}), format v${payload.version}`);
  const r = importBackup(db, payload);
  console.log(`Restored ${r.restored} file(s); kept ${r.keptExisting} already present; ${r.toStore} placed in MemoryCentral's own store.\n`);
  console.log(formatSyncStats(await syncAll(db)));
  console.log('\n✓  Import complete.');
} finally {
  db.close();
}
