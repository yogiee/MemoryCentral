import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { openDb } from './db.js';
import { embed, cosineSimilarity } from './ollama.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const REPO         = join(__dirname, '..');
const DASHBOARD    = join(REPO, 'dashboard', 'DASHBOARD.md');
const SYNC_SCRIPT  = join(REPO, 'sync.sh');

const db = openDb();

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'memory-central', version: '2.0.0' });

server.registerTool(
  'list_projects',
  { description: 'List all tracked projects with description, stack, and memory count.' },
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

server.registerTool(
  'get_project_summary',
  {
    description: 'Structured summary of a project: description, stack, all memory titles grouped by type.',
    inputSchema: z.object({ project: z.string() }),
  },
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

server.registerTool(
  'get_project_memories',
  {
    description: 'Full content of all memory files for a project.',
    inputSchema: z.object({ project: z.string() }),
  },
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

server.registerTool(
  'search_memories',
  {
    description: 'Full-text search across all project memories using FTS5. Optionally filter by project.',
    inputSchema: z.object({
      query:   z.string().describe('Search terms'),
      project: z.string().optional().describe('Limit to a specific project name (optional)'),
    }),
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

server.registerTool(
  'find_by_stack',
  {
    description: 'Find all projects using a specific technology. Use lowercase tags e.g. swift, node, python.',
    inputSchema: z.object({ stack: z.string() }),
  },
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

server.registerTool(
  'find_similar',
  {
    description: 'Semantic search: find memory entries similar to a description using embeddings. Best for conceptual lookups like "how we handled auth" or "scroll component implementation".',
    inputSchema: z.object({
      description: z.string().describe('Describe what you are looking for'),
      limit:       z.number().default(5),
    }),
  },
  async ({ description, limit = 5 }) => {
    let queryVec;
    try {
      queryVec = await embed(description);
    } catch {
      return { content: [{ type: 'text', text: 'Ollama embedding service unavailable.' }], isError: true };
    }

    const rows = db.prepare(`
      SELECT e.memory_id, e.vector, m.title, m.filename, m.content, m.memory_type, p.name AS project_name
      FROM embeddings e
      JOIN memories m ON m.id = e.memory_id
      JOIN projects p ON p.id = m.project_id
    `).all();

    const scored = rows
      .map(r => ({ ...r, score: cosineSimilarity(queryVec, JSON.parse(r.vector)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (!scored.length) return { content: [{ type: 'text', text: 'No embeddings found — run sync first.' }] };

    const text = scored.map(r => [
      `**${r.project_name}/${r.filename}** [${r.memory_type}] — score: ${r.score.toFixed(3)}`,
      `_${r.title}_`,
      r.content.slice(0, 400) + (r.content.length > 400 ? '…' : ''),
    ].join('\n')).join('\n\n---\n\n');

    return { content: [{ type: 'text', text: `# Similar to "${description}"\n\n${text}` }] };
  },
);

server.registerTool(
  'get_dashboard',
  { description: 'Cross-project dashboard grouped by tech stack.' },
  async () => {
    if (!existsSync(DASHBOARD)) {
      return { content: [{ type: 'text', text: 'Dashboard not found — run ./sync.sh first.' }], isError: true };
    }
    return { content: [{ type: 'text', text: readFileSync(DASHBOARD, 'utf8') }] };
  },
);

server.registerTool(
  'sync',
  { description: 'Trigger a memory sync from all Claude project sessions without committing to git.' },
  async () => new Promise(resolve => {
    const proc = spawn('bash', [SYNC_SCRIPT, '--no-commit'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
// Boot
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('MemoryCentral MCP server v2 running');
