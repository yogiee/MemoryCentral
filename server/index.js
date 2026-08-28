import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { openDb } from './db.js';
import { embed, cosineSimilarity, activeModel } from './embed.js';
import { countPending, embedMemory, startBackfillLoop } from './backlog.js';
import { embedHash } from './chunk.js';
import { memoryType, extractTitle } from './meta.js';
import { start as startDashboard } from './dashboard.js';
import { writeManifest } from './manifest.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const REPO         = join(__dirname, '..');
const DASHBOARD    = join(REPO, 'dashboard', 'DASHBOARD.md');
const SYNC_SCRIPT  = join(REPO, 'sync.js');
const HOME         = homedir();

const db = openDb();

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'memoryCentral', version: '2.0.0' });

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
    const params = [query];
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
    const embedResult = await embed(description);

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
  'Write a memory entry to a project — saves to both the filesystem and the knowledge DB with embeddings. Use mid-session to persist discoveries, decisions, or context without waiting for the next sync.',
  {
    project:  z.string().describe('Exact project name as shown in list_projects (e.g. "IPMSGX")'),
    filename: z.string().describe('Memory filename e.g. "feedback_auth.md", "project_decisions.md"'),
    content:  z.string().describe('Full markdown content — include frontmatter if applicable'),
  },
  async ({ project, filename, content }) => {
    const p = db.prepare('SELECT * FROM projects WHERE name=?').get(project);
    if (!p) {
      return {
        content: [{ type: 'text', text: `Project "${project}" not found. Run the "sync" tool first to register it, then retry.` }],
        isError: true,
      };
    }

    const memDir = join(HOME, '.claude', 'projects', p.encoded_path, 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, filename), content);

    const type     = memoryType(filename, content);
    const title    = extractTitle(content, filename);
    const hash     = embedHash(title, content);
    const now      = new Date().toISOString();
    const existing = db.prepare('SELECT id, content FROM memories WHERE project_id=? AND filename=?').get(p.id, filename);

    let memId, action;
    if (!existing) {
      const { id } = db.prepare(
        'INSERT INTO memories (project_id, filename, memory_type, title, content, embed_hash, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(p.id, filename, type, title, content, hash, now);
      db.prepare('INSERT INTO memories_fts (rowid, title, content, project_name, memory_type) VALUES (?, ?, ?, ?, ?)').run(id, title, content, project, type);
      memId = id; action = 'Created';
    } else if (existing.content !== content) {
      db.prepare('UPDATE memories SET memory_type=?, title=?, content=?, embed_hash=?, synced_at=? WHERE id=?').run(type, title, content, hash, now, existing.id);
      db.prepare('DELETE FROM memories_fts WHERE rowid=?').run(existing.id);
      db.prepare('INSERT INTO memories_fts (rowid, title, content, project_name, memory_type) VALUES (?, ?, ?, ?, ?)').run(existing.id, title, content, project, type);
      memId = existing.id; action = 'Updated';
    } else {
      // Byte-identical content. Re-saving is the obvious retry after a save that
      // reported "embedding pending", so check the vectors before short-circuiting
      // — the old early return made that retry impossible and a memory could sit
      // unembedded indefinitely (found 2026-08-28).
      const current = db.prepare('SELECT COUNT(*) AS n FROM embeddings WHERE memory_id=? AND model=? AND embed_hash=?')
        .get(existing.id, activeModel(), hash).n;
      if (current) {
        return { content: [{ type: 'text', text: `"${filename}" in ${project} is already up-to-date.` }] };
      }
      memId = existing.id; action = 'Re-embedded';
    }

    const embedded = await embedMemory(db, { id: memId, title, content, embed_hash: hash });

    // Name the actual failure. This message used to read "provider unavailable"
    // for every cause, and said exactly that while Ollama was healthy — which is
    // why nobody chased it and 14 memories drifted (2026-08-28).
    const embedNote = embedded.ok
      ? ''
      : `\n⚠ Embedding pending — ${embedded.reason}: ${embedded.message}\n` +
        `  Keyword search works now; semantic search picks it up after auto-backfill (or save again to retry).`;
    return { content: [{ type: 'text', text: `${action} "${filename}" in ${project}.\nWritten to: ${join(memDir, filename)}${embedNote}` }] };
  },
);

server.tool(
  'get_dashboard',
  'Cross-project dashboard grouped by tech stack.',
  async () => {
    if (!existsSync(DASHBOARD)) {
      return { content: [{ type: 'text', text: 'Dashboard not found — run node sync.js first.' }], isError: true };
    }
    return { content: [{ type: 'text', text: readFileSync(DASHBOARD, 'utf8') }] };
  },
);

server.tool(
  'sync',
  'Trigger a memory sync from all Claude project sessions without committing to git.',
  async () => new Promise(resolve => {
    const proc = spawn(process.execPath, [SYNC_SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('close', code => resolve({
      content: [{ type: 'text', text: code === 0 ? `Sync complete:\n\n${out}` : `Sync failed (exit ${code}):\n\n${out}` }],
      isError: code !== 0,
    }));
  }),
);

// ---------------------------------------------------------------------------
// Prompts — usage guidance for MCP hosts
// ---------------------------------------------------------------------------

const USAGE_INSTRUCTIONS = `\
## MemoryCentral — cross-project knowledge

You have access to a persistent knowledge bank of decisions, solutions, and discoveries \
from ALL of the user's projects — not just this one.

**When to use:**
- \`memoryCentral__find_similar(description)\` — Semantic search. Use proactively when: \
the user asks how something was done before ("how did we do X?"), you're about to \
implement a known pattern (auth, scroll, caching, navigation, persistence, networking), \
or you suspect a prior solution exists in another project.
- \`memoryCentral__search_memories(query, project?)\` — Keyword search. Use for specific \
named things: a library name, a tool, an architectural decision.
- \`memoryCentral__get_project_memories(project)\` — Full memory dump for one project. \
Use when the user explicitly asks about a specific project's history.

**Conventions:**
- Check MemoryCentral before solving a problem from scratch. If a prior solution \
surfaces, verify it's still valid, then apply it.
- Don't announce you checked if nothing relevant comes back — just proceed normally.
- \`memoryCentral__save_memory\` persists knowledge across Claude sessions; use \
\`save_memory\` (the builtin tool) for project-local notes instead.`;

server.prompt(
  'usage_instructions',
  'System prompt fragment for AI assistants — when and how to use MemoryCentral tools for cross-project knowledge retrieval.',
  async () => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: USAGE_INSTRUCTIONS },
    }],
  }),
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
startDashboard(9980);

// Refresh the consumer manifest for BenchLLAMA every session launch (Ollama-independent,
// best-effort). See server/manifest.js + docs/consumer-manifest.md.
writeManifest();

// Backfill embeddings left pending by provider outages. Runs for the life of the
// process rather than once at boot: the provider is often not ready at launch,
// and a reconnect is just another boot into the same window (defect 2, 2026-08-28).
startBackfillLoop(db, msg => console.error(`memoryCentral: ${msg}`));

console.error('MemoryCentral MCP server v2 running');
