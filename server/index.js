import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, '..', 'projects');
const DASHBOARD_FILE = join(__dirname, '..', 'dashboard', 'DASHBOARD.md');

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function listProjects() {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function memoryFiles(project) {
  const dir = join(PROJECTS_DIR, project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
}

function readMeta(project) {
  const metaPath = join(PROJECTS_DIR, project, '_meta.md');
  if (!existsSync(metaPath)) return {};
  const raw = readFileSync(metaPath, 'utf8');
  return {
    syncedAt: (raw.match(/synced_at:\s*(.+)/) ?? [])[1]?.trim(),
    fileCount: (raw.match(/memory_files:\s*(\d+)/) ?? [])[1],
  };
}

function readAllMemories(project) {
  return memoryFiles(project)
    .map(f => `## ${f}\n\n${readFileSync(join(PROJECTS_DIR, project, f), 'utf8')}`)
    .join('\n\n---\n\n');
}

function searchAllProjects(query) {
  const lq = query.toLowerCase();
  const results = [];

  for (const project of listProjects()) {
    for (const file of memoryFiles(project)) {
      const content = readFileSync(join(PROJECTS_DIR, project, file), 'utf8');
      if (!content.toLowerCase().includes(lq)) continue;

      const matches = content
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => line.toLowerCase().includes(lq))
        .slice(0, 5)
        .map(({ line, i }) => `  L${i + 1}: ${line.trim()}`)
        .join('\n');

      results.push(`**${project}/${file}**\n${matches}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'memory-central', version: '1.0.0' });

server.registerTool(
  'list_projects',
  { description: 'List all Claude projects tracked in MemoryCentral with memory file counts and last sync time.' },
  async () => {
    const projects = listProjects();
    const lines = projects.map(p => {
      const { syncedAt } = readMeta(p);
      const count = memoryFiles(p).length;
      return `- **${p}** — ${count} file(s)${syncedAt ? `  _(synced: ${syncedAt})_` : ''}`;
    });
    return {
      content: [{ type: 'text', text: `# Projects (${projects.length})\n\n${lines.join('\n')}` }],
    };
  },
);

server.registerTool(
  'get_project_memories',
  {
    description: 'Return all memory files for a specific project, concatenated.',
    inputSchema: z.object({
      project: z.string().describe('Project name as returned by list_projects'),
    }),
  },
  async ({ project }) => {
    const all = listProjects();
    if (!all.includes(project)) {
      return {
        content: [{ type: 'text', text: `Project "${project}" not found. Available: ${all.join(', ')}` }],
        isError: true,
      };
    }
    const content = readAllMemories(project);
    return {
      content: [{ type: 'text', text: content || '_No memory files._' }],
    };
  },
);

server.registerTool(
  'search_memories',
  {
    description: 'Full-text keyword search across all project memory files. Returns matching file names and lines.',
    inputSchema: z.object({
      query: z.string().describe('Keyword or phrase to search for'),
    }),
  },
  async ({ query }) => {
    const results = searchAllProjects(query);
    const text = results.length
      ? `# "${query}" — ${results.length} match(es)\n\n${results.join('\n\n')}`
      : `No matches for "${query}".`;
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'get_dashboard',
  { description: 'Return the MemoryCentral cross-project dashboard. Run sync.sh first to refresh it.' },
  async () => {
    if (!existsSync(DASHBOARD_FILE)) {
      return {
        content: [{ type: 'text', text: 'Dashboard not found — run ./sync.sh first.' }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: readFileSync(DASHBOARD_FILE, 'utf8') }],
    };
  },
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MemoryCentral MCP server running');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
