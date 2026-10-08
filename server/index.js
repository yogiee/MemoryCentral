import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { openDb, ftsQuery } from './db.js';
import { embed, cosineSimilarity } from './embed.js';
import { countPending, startBackfillLoop } from './backlog.js';
import { syncAll, formatSyncStats } from './ingest.js';
import { saveMemory, deleteMemory } from './store.js';
import { generatedDir } from './paths.js';
import { start as startDashboard } from './dashboard.js';
import { writeManifest } from './manifest.js';
import { INSTRUCTIONS, USAGE_PROMPT } from './instructions.js';

const db = openDb();

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// `instructions` reaches every client that supports MCP server instructions (Claude
// Code, Codex, VS Code), so the when-to-use guidance no longer depends on a
// harness-specific config file.
const server = new McpServer({ name: 'memoryCentral', version: '3.0.0' }, { instructions: INSTRUCTIONS });

server.tool(
  'list_projects',
  'List all tracked projects with description, stack, and memory count.',
  async () => {
    const projects = db.prepare(`
      SELECT p.name, p.description, p.stack, p.last_synced, COUNT(m.id) AS mem_count
      FROM projects p
      LEFT JOIN memories m ON m.project_id = p.id
      GROUP BY p.id ORDER BY p.name
    `).all();

    const lines = projects.map(p => {
      const stack = JSON.parse(p.stack || '[]');
      return [
        `## ${p.name}`,
        p.description || '_No description_',
        `Stack: ${stack.join(', ') || 'unknown'} | ${p.mem_count} memories | synced: ${p.last_synced}`,
      ].join('\n');
    });

    return { content: [{ type: 'text', text: `# Projects (${projects.length})\n\n${lines.join('\n\n')}` }] };
  },
);

server.tool(
  'get_project_summary',
  'Structured summary of a project: description, stack, all memory titles grouped by type.',
  { project: z.string() },
  async ({ project }) => {
    const p = db.prepare('SELECT * FROM projects WHERE name=?').get(project);
    if (!p) return { content: [{ type: 'text', text: `Project "${project}" not found.` }], isError: true };

    const memories = db.prepare(
      'SELECT filename, memory_type, title FROM memories WHERE project_id=? ORDER BY memory_type, filename'
    ).all(p.id);

    const stack = JSON.parse(p.stack || '[]');
    const grouped = {};
    for (const m of memories) (grouped[m.memory_type] = grouped[m.memory_type] || []).push(m);

    const lines = [
      `# ${p.name}`,
      '',
      `**Description:** ${p.description || 'unknown'}`,
      `**Stack:** ${stack.join(', ') || 'unknown'}`,
      `**Last synced:** ${p.last_synced}`,
      '',
    ];

    for (const [type, items] of Object.entries(grouped)) {
      lines.push(`## ${type}`);
      for (const m of items) lines.push(`- \`${m.filename}\` — ${m.title}`);
      lines.push('');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'get_project_memories',
  'Full content of all memory files for a project.',
  { project: z.string() },
  async ({ project }) => {
    const p = db.prepare('SELECT id FROM projects WHERE name=?').get(project);
    if (!p) return { content: [{ type: 'text', text: `Project "${project}" not found.` }], isError: true };

    const memories = db.prepare(
      'SELECT filename, memory_type, title, content FROM memories WHERE project_id=? ORDER BY memory_type, filename'
    ).all(p.id);

    const text = memories
      .map(m => `## ${m.filename} [${m.memory_type}]\n_${m.title}_\n\n${m.content}`)
      .join('\n\n---\n\n');

    return { content: [{ type: 'text', text: text || '_No memories found._' }] };
  },
);

server.tool(
  'search_memories',
  'Full-text search across all project memories using FTS5. Optionally filter by project.',
  {
    query:   z.string().describe('Search terms'),
    project: z.string().optional().describe('Limit to a specific project name (optional)'),
  },
  async ({ query, project }) => {
    let sql = `
      SELECT m.id, m.filename, m.memory_type, m.title, m.content, p.name AS project_name, fts.rank
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      JOIN projects p ON p.id = m.project_id
      WHERE memories_fts MATCH ?
    `;
    const params = [ftsQuery(query)];
    if (project) { sql += ' AND p.name=?'; params.push(project); }
    sql += ' ORDER BY fts.rank LIMIT 20';

    let results;
    try {
      results = db.prepare(sql).all(...params);
    } catch (err) {
      return { content: [{ type: 'text', text: `Search error: ${err.message}` }], isError: true };
    }

    if (!results.length) return { content: [{ type: 'text', text: `No results for "${query}".` }] };

    const text = results.map(r => [
      `**${r.project_name}/${r.filename}** [${r.memory_type}]`,
      `_${r.title}_`,
      r.content.slice(0, 400) + (r.content.length > 400 ? '…' : ''),
    ].join('\n')).join('\n\n---\n\n');

    return { content: [{ type: 'text', text: `# "${query}" — ${results.length} result(s)\n\n${text}` }] };
  },
);

server.tool(
  'find_by_stack',
  'Find all projects using a specific technology. Use lowercase tags e.g. swift, node, python.',
  { stack: z.string() },
  async ({ stack }) => {
    const projects = db.prepare(`
      SELECT p.name, p.description, p.stack, COUNT(m.id) AS mem_count
      FROM projects p
      LEFT JOIN memories m ON m.project_id = p.id
      WHERE p.stack LIKE ?
      GROUP BY p.id ORDER BY p.name
    `).all(`%"${stack}"%`);

    if (!projects.length) return { content: [{ type: 'text', text: `No projects found with stack tag "${stack}".` }] };

    const lines = projects.map(p => {
      const tags = JSON.parse(p.stack || '[]');
      return `- **${p.name}** (${tags.join(', ')}) — ${p.description || 'no description'} [${p.mem_count} memories]`;
    });

    return { content: [{ type: 'text', text: `# Projects using "${stack}" (${projects.length})\n\n${lines.join('\n')}` }] };
  },
);

server.tool(
  'find_similar',
  'Semantic search: find memory entries similar to a description using embeddings. Best for conceptual lookups like "how we handled auth" or "scroll component implementation".',
  {
    description: z.string().describe('Describe what you are looking for'),
    limit:       z.number().optional().describe('Max results (default 5)'),
  },
  async ({ description, limit = 5 }) => {
    const embedResult = await embed(description, { kind: 'query' });

    // Degraded mode: no query vector — return all content for in-context matching
    if (!embedResult.ok) {
      const all = db.prepare(`
        SELECT m.title, m.filename, m.content, m.memory_type, p.name AS project_name
        FROM memories m JOIN projects p ON p.id = m.project_id
        ORDER BY p.name, m.filename
      `).all();
      if (!all.length) return { content: [{ type: 'text', text: 'No memories found — run sync first.' }] };
      const text = [
        `⚠ Semantic search degraded — could not embed the query (${embedResult.reason}: ${embedResult.message}). ` +
        `Review the ${all.length} memories below and identify which best match: "${description}"`,
        '',
        ...all.map(r => `**${r.project_name}/${r.filename}** [${r.memory_type}]\n_${r.title}_\n${r.content.slice(0, 300)}${r.content.length > 300 ? '…' : ''}`),
      ].join('\n\n---\n\n');
      return { content: [{ type: 'text', text }] };
    }

    const { vector: queryVec, model } = embedResult;
    const rows = db.prepare(`
      SELECT e.memory_id, e.vector, e.chunk_index, e.start_char, e.end_char,
             m.title, m.filename, m.content, m.memory_type, p.name AS project_name
      FROM embeddings e
      JOIN memories m ON m.id = e.memory_id
      JOIN projects p ON p.id = m.project_id
      WHERE e.model = ?
    `).all(model);

    if (!rows.length) return { content: [{ type: 'text', text: 'No embeddings found — run sync first.' }] };

    // A long memory is several chunk vectors (see chunk.js). Score them all, then
    // keep each memory's best-matching chunk — without the collapse, one 39 KB
    // memory would fill the result list with fourteen of its own sections.
    const best = new Map();
    const chunkCount = new Map();
    for (const r of rows) {
      chunkCount.set(r.memory_id, (chunkCount.get(r.memory_id) || 0) + 1);
      const score = cosineSimilarity(queryVec, JSON.parse(r.vector));
      const held = best.get(r.memory_id);
      if (!held || score > held.score) best.set(r.memory_id, { ...r, score });
    }

    const scored = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);

    const text = scored.map(r => {
      // Quote the passage that actually matched, not the head of the document —
      // for a long memory those are rarely the same place.
      const total  = chunkCount.get(r.memory_id);
      const body   = r.content.slice(r.start_char, r.end_char);
      const where  = total > 1 ? ` (chunk ${r.chunk_index + 1}/${total})` : '';
      const excerpt = (r.start_char > 0 ? '…' : '') + body.slice(0, 400) + (body.length > 400 ? '…' : '');
      return [
        `**${r.project_name}/${r.filename}** [${r.memory_type}] — score: ${r.score.toFixed(3)}${where}`,
        `_${r.title}_`,
        excerpt,
      ].join('\n');
    }).join('\n\n---\n\n');

    // A memory is missing here if it has no current-model vector at all (saved
    // during a provider outage), and misranked if its vectors predate its current
    // text. Both states are what countPending measures now — say so either way.
    const pending = countPending(db);
    const pendingNote = pending
      ? `\n\n_⚠ ${pending} memorie(s) have no current vector for the text they now hold — they are missing from these results, ` +
        `or matched on superseded content. Keyword search (search_memories) is unaffected._`
      : '';

    return { content: [{ type: 'text', text: `# Similar to "${description}" (via ${model})\n\n${text}${pendingNote}` }] };
  },
);

server.tool(
  'save_memory',
  'Save a memory (a decision, fix, gotcha or reference) to a project so any future session, in any AI tool, can find it. ' +
  'Creates the project if it is new. Re-saving a filename updates that memory in place.',
  {
    project:      z.string().describe("Project name: the `Project:` line of the repo's MemoryCentral block if it has one, else the repo folder name"),
    filename:     z.string().describe('Memory filename, e.g. "feedback_auth.md" or "project_decisions.md" (a plain .md name, no folders)'),
    content:      z.string().describe('Full markdown content; frontmatter with name/description/type is recommended'),
    project_path: z.string().optional().describe("Absolute path of the project's repository, if known (lets MemoryCentral read its MemoryCentral block)"),
  },
  async ({ project, filename, content, project_path }) => {
    const r = await saveMemory(db, { project, filename, content, projectPath: project_path ?? null });
    if (!r.ok) return { content: [{ type: 'text', text: `Not saved: ${r.reason}` }], isError: true };
    const action = r.created ? 'Created' : r.changed ? 'Updated' : 'Already up to date:';
    // Name the actual embedding failure, never a generic "unavailable" (2026-08-28).
    const note = r.embedded ? '' :
      `\n⚠ Embedding pending — ${r.reason}\n  Keyword search works now; semantic search picks it up after auto-backfill (or save again to retry).`;
    return { content: [{ type: 'text', text: `${action} "${filename}" in ${project}.\nWritten to: ${r.path}${note}` }] };
  },
);

server.tool(
  'delete_memory',
  'Permanently delete a memory that is wrong or no longer true (stale decision, changed spec). Removes its file and its index entry. ' +
  'Use only when the user wants it gone; to correct a memory, save_memory the same filename instead.',
  {
    project:  z.string().describe('Exact project name as shown in list_projects'),
    filename: z.string().describe('The memory filename'),
  },
  async ({ project, filename }) => {
    const r = deleteMemory(db, { project, filename });
    if (!r.ok) return { content: [{ type: 'text', text: `Not deleted: ${r.reason}` }], isError: true };
    return { content: [{ type: 'text', text: `Deleted "${filename}" from ${project}${r.fileRemoved ? ' (file removed)' : ''}.` }] };
  },
);

server.tool(
  'get_dashboard',
  'Cross-project dashboard grouped by tech stack.',
  async () => {
    const file = join(generatedDir(), 'DASHBOARD.md');
    if (!existsSync(file)) return { content: [{ type: 'text', text: 'No dashboard yet — run the sync tool first.' }], isError: true };
    return { content: [{ type: 'text', text: readFileSync(file, 'utf8') }] };
  },
);

server.tool(
  'sync',
  'Re-read every memory source now (AI tools\' memory folders and MemoryCentral\'s own store). The server also does this on its own every few minutes.',
  async () => {
    const stats = await syncAll(db);
    return { content: [{ type: 'text', text: formatSyncStats(stats) }] };
  },
);

// ---------------------------------------------------------------------------
// Prompts — usage guidance for MCP hosts
// ---------------------------------------------------------------------------

server.prompt(
  'usage_instructions',
  'System prompt fragment for AI assistants — when and how to use MemoryCentral tools for cross-project knowledge retrieval.',
  async () => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: USAGE_PROMPT },
    }],
  }),
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
startDashboard(Number(process.env.MC_DASHBOARD_PORT) || 9980);

// Refresh the consumer manifest for BenchLLAMA every session launch (Ollama-independent,
// best-effort). See server/manifest.js + docs/consumer-manifest.md.
if (process.env.MC_MANIFEST !== '0') writeManifest();

// The server keeps the index current itself, so no harness needs a hook: a sync
// shortly after boot, then every SYNC_INTERVAL_MS. Every harness runs its own
// server; the sync lease (settings.js) makes all but one of them skip.
const SYNC_INTERVAL_MS = Number(process.env.MC_SYNC_INTERVAL_MS) || 5 * 60_000;
async function backgroundSync() {
  try {
    const s = await syncAll(db);
    if (!s.skipped && (s.added || s.updated || s.tombstoned || s.held)) console.error(`memoryCentral: ${formatSyncStats(s).split('\n')[0]}`);
  } catch (err) {
    console.error(`memoryCentral: background sync failed — ${err?.stack || err}`);
  }
}
setTimeout(backgroundSync, 2_000).unref();
setInterval(backgroundSync, SYNC_INTERVAL_MS).unref();

// Backfill embeddings left pending by provider outages. Runs for the life of the
// process rather than once at boot: the provider is often not ready at launch,
// and a reconnect is just another boot into the same window (defect 2, 2026-08-28).
startBackfillLoop(db, msg => console.error(`memoryCentral: ${msg}`));

console.error('MemoryCentral MCP server v3 running');
