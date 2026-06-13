import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { openDb } from './db.js';
import { embed, extractProjectMeta } from './embed.js';

const RC_PATH = join(homedir(), '.memorycentralrc.json');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO          = join(__dirname, '..');
const CLAUDE_PROJ   = join(homedir(), '.claude', 'projects');
const SNAPSHOTS_DIR = join(REPO, 'snapshots');
const DASHBOARD_DIR = join(REPO, 'dashboard');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function memoryType(filename) {
  for (const t of ['feedback', 'project', 'user', 'reference']) {
    if (filename.startsWith(t)) return t;
  }
  return 'general';
}

function extractTitle(content, filename) {
  const fm = content.match(/^---[\s\S]*?\nname:\s*(.+)/m);
  if (fm) return fm[1].trim();
  const h1 = content.match(/^#\s+(.+)/m);
  if (h1) return h1[1].trim();
  return filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}

function resolveProjectName(encoded) {
  const home = homedir();
  const homeEnc = home.replace(/[/\\]/g, '-');
  if (!encoded.startsWith(homeEnc)) return encoded.replace(/^-/, '');
  const rel = encoded.slice(homeEnc.length).replace(/^-/, '');
  if (!rel) return 'home';
  const tokens = rel.split('-');
  let current = home;
  let i = 0;
  while (i < tokens.length) {
    let seg = tokens[i++];
    while (!existsSync(join(current, seg)) && i < tokens.length) seg += '-' + tokens[i++];
    current = join(current, seg);
  }
  return basename(current);
}

function writeSnapshot(db, projectId, name) {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  const memories = db.prepare(
    "SELECT filename, memory_type, title FROM memories WHERE project_id=? ORDER BY memory_type, filename"
  ).all(projectId);

  const stack = JSON.parse(p.stack || '[]');
  const lines = [
    `# ${name}`,
    '',
    `**Description:** ${p.description || '_unknown_'}`,
    `**Stack:** ${stack.length ? stack.join(', ') : '_unknown_'}`,
    `**Last synced:** ${p.last_synced}`,
    '',
    '## Memories',
    '',
    ...memories.map(m => `- \`${m.filename}\` — [${m.memory_type}] ${m.title}`),
  ];

  writeFileSync(join(SNAPSHOTS_DIR, `${name}.md`), lines.join('\n') + '\n');
}

function writeDashboard(db) {
  const projects = db.prepare(`
    SELECT p.*, COUNT(m.id) as mem_count
    FROM projects p
    LEFT JOIN memories m ON m.project_id = p.id
    GROUP BY p.id
    ORDER BY p.name
  `).all();

  const ts = new Date().toUTCString();
  const lines = [
    '# MemoryCentral Dashboard',
    '',
    `_Last synced: ${ts}_`,
    '',
  ];

  // Group by primary stack tag
  const byStack = {};
  for (const p of projects) {
    const tags = JSON.parse(p.stack || '[]');
    const key = tags[0] || 'other';
    (byStack[key] = byStack[key] || []).push(p);
  }

  for (const [tag, projs] of Object.entries(byStack).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${tag}`);
    lines.push('');
    for (const p of projs) {
      const tags = JSON.parse(p.stack || '[]');
      lines.push(`### ${p.name}`);
      if (p.description) lines.push(p.description);
      lines.push(`_Stack: ${tags.join(', ') || 'unknown'} | ${p.mem_count} memories | synced: ${p.last_synced}_`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`_${projects.length} projects tracked_`);
  writeFileSync(join(DASHBOARD_DIR, 'DASHBOARD.md'), lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const db  = openDb();
  const now = new Date().toISOString();
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  mkdirSync(DASHBOARD_DIR, { recursive: true });

  const stats  = { projects: 0, added: 0, updated: 0, unchanged: 0 };
  const toEmbed = [];

  const stmts = {
    upsertProject: db.prepare(`
      INSERT INTO projects (name, encoded_path, last_synced, description, stack)
      VALUES (?, ?, ?, '', '[]')
      ON CONFLICT(name) DO UPDATE SET last_synced=excluded.last_synced, encoded_path=excluded.encoded_path
      RETURNING *
    `),
    updateMeta: db.prepare(`UPDATE projects SET description=?, stack=? WHERE id=?`),
    getMemory:  db.prepare(`SELECT id, content FROM memories WHERE project_id=? AND filename=?`),
    insertMem:  db.prepare(`
      INSERT INTO memories (project_id, filename, memory_type, title, content, synced_at)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id
    `),
    updateMem:  db.prepare(`UPDATE memories SET memory_type=?, title=?, content=?, synced_at=? WHERE id=?`),
    insertFts:  db.prepare(`INSERT INTO memories_fts (rowid, title, content, project_name, memory_type) VALUES (?, ?, ?, ?, ?)`),
    deleteFts:  db.prepare(`DELETE FROM memories_fts WHERE rowid=?`),
    upsertEmbed: db.prepare(`
      INSERT INTO embeddings (memory_id, vector, model, generated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET vector=excluded.vector, model=excluded.model, generated_at=excluded.generated_at
    `),
  };

  // Helper: ingest all .md files from a directory into a project
  async function processDir(dir, projectId, projectName) {
    if (!existsSync(dir)) return { allContent: '', added: 0, updated: 0 };
    const mdFiles = readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
    let allContent = '';
    let added = 0, updated = 0;
    for (const filename of mdFiles) {
      const content = readFileSync(join(dir, filename), 'utf8');
      allContent += content + '\n';
      if (filename === 'MEMORY.md') continue;
      const type     = memoryType(filename);
      const title    = extractTitle(content, filename);
      const existing = stmts.getMemory.get(projectId, filename);
      if (!existing) {
        const { id } = stmts.insertMem.get(projectId, filename, type, title, content, now);
        stmts.insertFts.run(id, title, content, projectName, type);
        toEmbed.push({ id, text: `${title}\n\n${content}` });
        stats.added++; added++;
      } else if (existing.content !== content) {
        stmts.updateMem.run(type, title, content, now, existing.id);
        stmts.deleteFts.run(existing.id);
        stmts.insertFts.run(existing.id, title, content, projectName, type);
        toEmbed.push({ id: existing.id, text: `${title}\n\n${content}` });
        stats.updated++; updated++;
      } else {
        stats.unchanged++;
      }
    }
    return { allContent, added, updated };
  }

  // Load extra paths config
  const extraPaths = existsSync(RC_PATH)
    ? (JSON.parse(readFileSync(RC_PATH, 'utf8')).extraPaths || {})
    : {};

  const seenProjects = new Set();

  for (const entry of readdirSync(CLAUDE_PROJ, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const memDir = join(CLAUDE_PROJ, entry.name, 'memory');
    if (!existsSync(memDir)) continue;

    const mdFiles = readdirSync(memDir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
    if (!mdFiles.length) continue;

    const name    = resolveProjectName(entry.name);
    const project = stmts.upsertProject.get(name, entry.name, now);
    stats.projects++;
    seenProjects.add(name);

    let pAdded = 0, pUpdated = 0, allContent = '';

    const std = await processDir(memDir, project.id, name);
    allContent += std.allContent;
    pAdded += std.added; pUpdated += std.updated;

    // Extra paths for this project
    for (const extraDir of (extraPaths[name] || [])) {
      const extra = await processDir(extraDir, project.id, name);
      allContent += extra.allContent;
      pAdded += extra.added; pUpdated += extra.updated;
    }

    // Extract description + stack via Ollama if missing
    if (!project.description) {
      process.stderr.write(`  Extracting meta for ${name}...\n`);
      try {
        const meta = await extractProjectMeta(allContent);
        stmts.updateMeta.run(meta.description, JSON.stringify(meta.stack), project.id);
      } catch (err) {
        process.stderr.write(`  Warning: meta extraction failed (${name}): ${err.message}\n`);
      }
    }

    writeSnapshot(db, project.id, name);
    const tag = pAdded || pUpdated ? ` +${pAdded} ~${pUpdated}` : ' (no changes)';
    process.stdout.write(`  ✓  ${name}${tag}\n`);
  }

  // Extra-paths-only projects (no ~/.claude/projects/ entry)
  for (const [projectName, dirs] of Object.entries(extraPaths)) {
    if (seenProjects.has(projectName)) continue;
    const encodedPath = 'extra-' + projectName;
    const project = stmts.upsertProject.get(projectName, encodedPath, now);
    stats.projects++;
    let allContent = '', pAdded = 0, pUpdated = 0;
    for (const extraDir of dirs) {
      const extra = await processDir(extraDir, project.id, projectName);
      allContent += extra.allContent;
      pAdded += extra.added; pUpdated += extra.updated;
    }
    if (!project.description && allContent) {
      try {
        const meta = await extractProjectMeta(allContent);
        stmts.updateMeta.run(meta.description, JSON.stringify(meta.stack), project.id);
      } catch {}
    }
    writeSnapshot(db, project.id, projectName);
    const tag = pAdded || pUpdated ? ` +${pAdded} ~${pUpdated}` : ' (no changes)';
    process.stdout.write(`  ✓  ${projectName} [extra]${tag}\n`);
  }

  // Generate embeddings for new/changed entries
  if (toEmbed.length) {
    process.stderr.write(`\nGenerating ${toEmbed.length} embedding(s)...\n`);
    for (const { id, text } of toEmbed) {
      const result = await embed(text); // embed() applies EMBED_MAX_CHARS
      if (result) {
        stmts.upsertEmbed.run(id, JSON.stringify(result.vector), result.model, now);
      }
    }
  }

  writeDashboard(db);

  db.prepare(`
    INSERT INTO sync_events (synced_at, projects_synced, files_added, files_updated, files_unchanged)
    VALUES (?, ?, ?, ?, ?)
  `).run(now, stats.projects, stats.added, stats.updated, stats.unchanged);

  db.close();

  process.stdout.write(
    `\nSynced: ${stats.projects} projects | +${stats.added} added | ~${stats.updated} updated | ${stats.unchanged} unchanged\n`
  );
}

main().catch(err => { console.error(err); process.exit(1); });
