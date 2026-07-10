// Pending-embedding backlog.
//
// There is no queue table: the invariant "vector missing OR from a different
// model than the active provider's" IS the backlog, computed straight from the
// embeddings table. When the provider is down, sync/save_memory write the memory
// to DB + FTS (keyword search keeps working) and simply skip the vector; sync
// and the MCP server call drainPending() whenever the provider is reachable, so
// the backlog self-heals with no extra state to maintain.

import { embed, activeModel } from './embed.js';

const PENDING_WHERE = 'e.memory_id IS NULL OR e.model != ?';

export function countPending(db) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM memories m
    LEFT JOIN embeddings e ON e.memory_id = m.id
    WHERE ${PENDING_WHERE}
  `).get(activeModel()).n;
}

// Re-embed every pending memory. Probes the provider on one throwaway call first
// so a down provider costs one failed request, not one per row; aborts after 3
// consecutive mid-run failures for the same reason. Returns { drained, remaining }.
export async function drainPending(db, log = () => {}) {
  const rows = db.prepare(`
    SELECT m.id, m.title, m.content FROM memories m
    LEFT JOIN embeddings e ON e.memory_id = m.id
    WHERE ${PENDING_WHERE}
    ORDER BY m.id
  `).all(activeModel());
  if (!rows.length) return { drained: 0, remaining: 0 };

  if (!await embed('embedding provider probe')) {
    return { drained: 0, remaining: rows.length };
  }

  const upsert = db.prepare(`
    INSERT INTO embeddings (memory_id, vector, model, generated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET vector=excluded.vector, model=excluded.model, generated_at=excluded.generated_at
  `);
  const now = new Date().toISOString();
  let drained = 0, consecutiveFailures = 0;

  for (const r of rows) {
    const result = await embed(`${r.title}\n\n${r.content}`); // embed() applies EMBED_MAX_CHARS
    if (!result) {
      if (++consecutiveFailures >= 3) break; // provider dropped mid-drain
      continue;
    }
    consecutiveFailures = 0;
    upsert.run(r.id, JSON.stringify(result.vector), result.model, now);
    drained++;
    if (drained % 25 === 0) log(`  backlog: ${drained}/${rows.length}`);
  }

  return { drained, remaining: rows.length - drained };
}
