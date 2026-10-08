// CLI: run one sync now. `node sync.js` (repo root) and the optional Claude Code
// Stop hook both land here. The MCP server and the dashboard sync on their own
// (ingest.js), so this is a convenience, not a requirement.
import { openDb } from './db.js';
import { syncAll, formatSyncStats } from './ingest.js';

const db = openDb();
try {
  const stats = await syncAll(db, {
    onProgress: p => { if (p.phase === 'embed' && p.i === 1) process.stderr.write(`Embedding ${p.n} memorie(s)...\n`); },
  });
  process.stdout.write(formatSyncStats(stats) + '\n');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  db.close();
}
