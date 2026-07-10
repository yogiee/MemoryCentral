import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { openDb } from './db.js';
import { embed, extractProjectMeta, EMBED_PROVIDER } from './embed.js';
import { drainPending, countPending } from './backlog.js';
import { memoryType, extractTitle } from './meta.js';

const RC_PATH = join(homedir(), '.memorycentralrc.json');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO          = join(__dirname, '..');
const CLAUDE_PROJ   = join(homedir(), '.claude', 'projects');
const SNAPSHOTS_DIR = join(REPO, 'snapshots');
const DASHBOARD_DIR = join(REPO, 'dashboard');

// --refresh-meta [project]: force description/stack re-extraction for all
// projects, or just the named one.
const argv = process.argv.slice(2);
const refreshIdx = argv.indexOf('--refresh-meta');
const refreshTarget = refreshIdx !== -1 && argv[refreshIdx + 1] && !argv[refreshIdx + 1].startsWith('--')
  ? argv[refreshIdx + 1] : null;
const wantsRefresh = name => refreshIdx !== -1 && (!refreshTarget || refreshTarget === name);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Decode a Claude-encoded directory name back to { name, path }. path is null
// for encodings outside the home dir (we can't reconstruct those reliably).
function resolveProject(encoded) {
  const home = homedir();
  const homeEnc = home.replace(/[/\\]/g, '-');
  if (!encoded.startsWith(homeEnc)) return { name: encoded.replace(/^-/, ''), path: null };
  const rel = encoded.slice(homeEnc.length).replace(/^-/, '');
  if (!rel) return { name: 'home', path: home };
  const tokens = rel.split('-');
  let current = home;
  let i = 0;
  while (i < tokens.length) {
    let seg = tokens[i++];
    while (!existsSync(join(current, seg)) && i < tokens.length) seg += '-' + tokens[i++];
    current = join(current, seg);
  }
  return { name: basename(current), path: current };
}

// Declared stack from the project's CLAUDE.md `## Stack` block — human-declared
// truth, trusted over LLM inference (open vocabulary; the STACK_TAGS allowlist
// applies only to the LLM-extraction fallback). Canonical form is one comma-
// separated line (`node, sqlite, mcp`); bullet lists are accepted by taking each
// item's leading token (`- Python 3.11+` → python). Tokens must look like tags —
// no spaces or prose punctuation — and a block that yields none (free prose)
// returns null so the LLM fallback handles it instead of us storing garbage.
function readClaudeMdStack(projectPath) {
  if (!projectPath) return null;
  const claudeMd = join(projectPath, 'CLAUDE.md');
  if (!existsSync(claudeMd)) return null;
  const src = readFileSync(claudeMd, 'utf8');
  const head = src.match(/^##\s+Stack[ \t]*\n/m);
  if (!head) return null;
  // Block = everything until the next heading (or EOF).
  const block = src.slice(head.index + head[0].length).split(/\n(?=#)/)[0];

  const candidates = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = line.match(/^[-*]\s+(.*)/);
    if (bullet) candidates.push(bullet[1].replace(/`/g, '').split(/\s+/)[0]);
    else candidates.push(...line.split(','));
  }
  const tags = [...new Set(
    candidates
      .map(t => t.replace(/`/g, '').trim().toLowerCase())
      .filter(t => /^[a-z][a-z0-9.@#+_-]{0,23}$/.test(t))
  )];
  return tags.length ? tags : null;
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
    updateMeta:  db.prepare(`UPDATE projects SET description=?, stack=?, meta_hash=? WHERE id=?`),
    updateStack: db.prepare(`UPDATE projects SET stack=? WHERE id=?`),
    getMemory:   db.prepare(`SELECT id, content, memory_type, title FROM memories WHERE project_id=? AND filename=?`),
    updateMemMeta: db.prepare(`UPDATE memories SET memory_type=?, title=? WHERE id=?`),
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
      const type     = memoryType(filename, content);
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
        // Content unchanged — but reclassify if the type/title rules evolved
        // (e.g. frontmatter-type support added 2026-07-10).
        if (existing.memory_type !== type || existing.title !== title) {
          stmts.updateMemMeta.run(type, title, existing.id);
        }
        stats.unchanged++;
      }
    }
    return { allContent, added, updated };
  }

  // Load config: extra memory paths + per-project stack overrides
  const rc = existsSync(RC_PATH) ? JSON.parse(readFileSync(RC_PATH, 'utf8')) : {};
  const extraPaths     = rc.extraPaths || {};
  const stackOverrides = rc.stackOverrides || {};

  // Stack hierarchy: rc override → CLAUDE.md `## Stack` block → LLM extraction.
  // Declared stacks refresh every sync (cheap file read). Descriptions re-extract
  // when the project's memory content drifts past the stored hash — so they track
  // reality instead of freezing at first sync — or when --refresh-meta forces it.
  async function refreshProjectMeta(project, name, projectPath, allContent) {
    const declared = stackOverrides[name] || readClaudeMdStack(projectPath);
    if (declared) stmts.updateStack.run(JSON.stringify(declared), project.id);

    if (!allContent) return;
    const contentHash = createHash('sha256').update(allContent).digest('hex').slice(0, 16);
    if (project.description && project.meta_hash === contentHash && !wantsRefresh(name)) return;

    process.stderr.write(`  Extracting meta for ${name}...\n`);
    try {
      const meta = await extractProjectMeta(allContent);
      if (!meta) {
        process.stderr.write(`  Warning: meta extraction unavailable (${name}) — Ollama down or model missing\n`);
        return;
      }
      const stack = declared || meta.stack;
      stmts.updateMeta.run(meta.description, JSON.stringify(stack), contentHash, project.id);
    } catch (err) {
      process.stderr.write(`  Warning: meta extraction failed (${name}): ${err.message}\n`);
    }
  }

  const seenProjects = new Set();

  for (const entry of readdirSync(CLAUDE_PROJ, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const memDir = join(CLAUDE_PROJ, entry.name, 'memory');
    if (!existsSync(memDir)) continue;

    const mdFiles = readdirSync(memDir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
    if (!mdFiles.length) continue;

    const { name, path: projectPath } = resolveProject(entry.name);
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

    await refreshProjectMeta(project, name, projectPath, allContent);

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

    await refreshProjectMeta(project, projectName, null, allContent);

    writeSnapshot(db, project.id, projectName);
    const tag = pAdded || pUpdated ? ` +${pAdded} ~${pUpdated}` : ' (no changes)';
    process.stdout.write(`  ✓  ${projectName} [extra]${tag}\n`);
  }

  // Generate embeddings for new/changed entries. Failures don't block the sync —
  // the memory is already in DB + FTS; the vector stays pending and is backfilled
  // by the drain below (or a later run) once the provider is back.
  if (toEmbed.length) {
    process.stderr.write(`\nGenerating ${toEmbed.length} embedding(s)...\n`);
    let consecutiveFailures = 0;
    for (const { id, text } of toEmbed) {
      if (consecutiveFailures >= 3) break; // provider down — stop hammering, leave the rest pending
      const result = await embed(text); // embed() applies EMBED_MAX_CHARS
      if (result) {
        stmts.upsertEmbed.run(id, JSON.stringify(result.vector), result.model, now);
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
      }
    }
  }

  // Backfill vectors left pending by earlier provider outages (probes first, so
  // this is one cheap failed call when the provider is down).
  const backlog = await drainPending(db, msg => process.stderr.write(msg + '\n'));
  if (backlog.drained) {
    process.stdout.write(`Backfilled ${backlog.drained} pending embedding(s).\n`);
  }

  writeDashboard(db);

  db.prepare(`
    INSERT INTO sync_events (synced_at, projects_synced, files_added, files_updated, files_unchanged)
    VALUES (?, ?, ?, ?, ?)
  `).run(now, stats.projects, stats.added, stats.updated, stats.unchanged);

  const pending = countPending(db);
  db.close();

  process.stdout.write(
    `\nSynced: ${stats.projects} projects | +${stats.added} added | ~${stats.updated} updated | ${stats.unchanged} unchanged\n`
  );
  if (pending) {
    process.stdout.write(
      `⚠  ${pending} memorie(s) pending embedding — provider "${EMBED_PROVIDER}" unavailable. ` +
      `Keyword search is unaffected; vectors backfill automatically on the next sync/boot with the provider up.\n`
    );
  }
}

main().catch(err => { console.error(err); process.exit(1); });
