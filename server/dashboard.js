// Dashboard HTTP server — imported by server/index.js (MCP process)
// and by the root dashboard.js standalone runner.
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { openDb } from './db.js';
import { EMBED_PROVIDER, activeModel } from './embed.js';
import { countPending } from './backlog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC   = join(__dirname, 'public');
const ASSETS   = join(__dirname, 'assets');
const SYNC_JS  = join(__dirname, '..', 'sync.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.svg':  'image/svg+xml',
};

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function getProjects(db) {
  const projects = db.prepare(`
    SELECT p.id, p.name, p.description, p.stack, p.last_synced,
           COUNT(m.id) AS mem_count,
           MAX(m.synced_at) AS last_activity
    FROM projects p
    LEFT JOIN memories m ON m.project_id = p.id
    GROUP BY p.id ORDER BY last_activity DESC, p.name
  `).all();

  const typeCounts = db.prepare(`
    SELECT project_id, memory_type, COUNT(*) AS cnt
    FROM memories GROUP BY project_id, memory_type
  `).all();

  const typeMap = {};
  for (const r of typeCounts) {
    if (!typeMap[r.project_id]) typeMap[r.project_id] = {};
    typeMap[r.project_id][r.memory_type] = r.cnt;
  }

  return projects.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description || null,
    stack: JSON.parse(p.stack || '[]'),
    lastSynced: p.last_synced,
    lastActivity: p.last_activity || p.last_synced,
    memCount: p.mem_count,
    types: typeMap[p.id] || {},
  }));
}

function getOverview(db) {
  const totals = db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS projects, COUNT(m.id) AS memories
    FROM projects p LEFT JOIN memories m ON m.project_id = p.id
  `).get();

  const byTypeRows = db.prepare(`
    SELECT memory_type, COUNT(*) AS cnt FROM memories GROUP BY memory_type
  `).all();

  const byStackRows = db.prepare(`
    SELECT p.stack, COUNT(m.id) AS cnt
    FROM projects p LEFT JOIN memories m ON m.project_id = p.id
    GROUP BY p.id
  `).all();

  const lastSync = db.prepare(
    `SELECT synced_at FROM sync_events ORDER BY synced_at DESC LIMIT 1`
  ).get();

  const sessions14d = db.prepare(`
    SELECT COUNT(*) AS cnt FROM sync_events
    WHERE synced_at >= DATETIME('now', '-14 days')
  `).get();

  const syncByDay = db.prepare(`
    SELECT DATE(synced_at) AS day, COUNT(*) AS cnt
    FROM sync_events
    WHERE synced_at >= DATETIME('now', '-14 days')
    GROUP BY DATE(synced_at)
    ORDER BY day
  `).all();

  const recentRows = db.prepare(`
    SELECT m.id, m.filename, m.memory_type, m.title, m.synced_at,
           p.name AS project_name,
           SUBSTR(m.content, 1, 280) AS excerpt
    FROM memories m JOIN projects p ON p.id = m.project_id
    ORDER BY m.synced_at DESC LIMIT 8
  `).all();

  // Configured embedding provider, plus how many memories lack current-model
  // vectors for the text they now hold (newly saved, edited since their last
  // embed, or written while the provider was down) and how many chunk vectors
  // back the corpus — long memories are several vectors each, see chunk.js.
  const embedStatus = {
    provider: EMBED_PROVIDER,
    model: activeModel(),
    pending: countPending(db),
    chunks: db.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n,
  };

  // Aggregate byStack
  const stackMap = {};
  for (const row of byStackRows) {
    const tags = JSON.parse(row.stack || '[]');
    const primary = tags[0] || 'other';
    stackMap[primary] = (stackMap[primary] || 0) + (row.cnt || 0);
  }
  const byStack = Object.entries(stackMap)
    .map(([stack, count]) => ({ stack, count }))
    .sort((a, b) => b.count - a.count);

  // Build type totals
  const byType = { feedback: 0, project: 0, user: 0, reference: 0, general: 0 };
  for (const r of byTypeRows) {
    if (r.memory_type in byType) byType[r.memory_type] = r.cnt;
    else byType.general = (byType.general || 0) + r.cnt;
  }

  // 14-day spark (oldest → newest)
  const dayMap = {};
  for (const r of syncByDay) dayMap[r.day] = r.cnt;
  const spark = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    spark.push(dayMap[d.toISOString().slice(0, 10)] || 0);
  }

  return {
    projects: totals.projects,
    memories: totals.memories,
    sessions14d: sessions14d.cnt,
    lastSync: lastSync?.synced_at || null,
    byStack,
    byType,
    sparkSessions: spark,
    recent: recentRows,
    embed: embedStatus,
  };
}

function getRecent(db, limit = 12) {
  return db.prepare(`
    SELECT m.id, m.filename, m.memory_type, m.title, m.synced_at,
           p.name AS project_name,
           SUBSTR(m.content, 1, 280) AS excerpt
    FROM memories m JOIN projects p ON p.id = m.project_id
    ORDER BY m.synced_at DESC LIMIT ?
  `).all(limit);
}

function searchMemories(db, q) {
  try {
    return db.prepare(`
      SELECT m.id, m.filename, m.memory_type, m.title, m.synced_at,
             p.name AS project_name,
             snippet(memories_fts, 2, '<mark>', '</mark>', '…', 30) AS excerpt
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      JOIN projects p ON p.id = m.project_id
      WHERE memories_fts MATCH ?
      ORDER BY fts.rank LIMIT 30
    `).all(q);
  } catch { return []; }
}

function getProjectMemories(db, name) {
  const p = db.prepare('SELECT id FROM projects WHERE name=?').get(name);
  if (!p) return null;
  return db.prepare(`
    SELECT id, filename, memory_type, title, synced_at,
           LENGTH(content) AS size_bytes,
           SUBSTR(content, 1, 280) AS excerpt
    FROM memories WHERE project_id=? ORDER BY memory_type, filename
  `).all(p.id);
}

function getMemory(db, id) {
  return db.prepare(`
    SELECT m.id, m.filename, m.memory_type, m.title, m.content, m.synced_at,
           p.name AS project_name, p.encoded_path,
           LENGTH(m.content) AS size_bytes
    FROM memories m JOIN projects p ON p.id = m.project_id
    WHERE m.id=?
  `).get(id);
}

// ---------------------------------------------------------------------------
// Static file helper
// ---------------------------------------------------------------------------

function serveStatic(res, filePath) {
  if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = extname(filePath);
  const ct = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ct });
  res.end(readFileSync(filePath));
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export function start(port = 9980, keepAlive = false) {
  const server = createServer((req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      handleGet(req, res, port);
    } else if (req.method === 'POST' && req.url === '/api/sync') {
      handleSync(res);
    } else {
      res.writeHead(405); res.end();
    }
  });

  server.on('error', err => {
    if (err.code !== 'EADDRINUSE')
      process.stderr.write('Dashboard error: ' + err.message + '\n');
  });

  server.listen(port, '127.0.0.1', () => {
    process.stderr.write('MemoryCentral dashboard → http://localhost:' + port + '\n');
  });

  if (!keepAlive) server.unref();
}

function handleGet(req, res, port) {
  const url = new URL(req.url, 'http://localhost:' + port);
  const path = url.pathname;

  // Static public files
  if (path === '/' || path === '') return serveStatic(res, join(PUBLIC, 'index.html'));
  if (path === '/styles.css') return serveStatic(res, join(PUBLIC, 'styles.css'));
  if (path === '/app.js')     return serveStatic(res, join(PUBLIC, 'app.js'));

  // Icon assets
  if (path.startsWith('/assets/icons/')) {
    const name = path.slice('/assets/icons/'.length);
    if (name && !name.includes('/') && name.endsWith('.svg'))
      return serveStatic(res, join(ASSETS, 'icons', name));
    res.writeHead(404); res.end(); return;
  }

  // Brand assets
  if (path.startsWith('/assets/brand/')) {
    const name = path.slice('/assets/brand/'.length);
    if (name && !name.includes('/') && name.endsWith('.svg'))
      return serveStatic(res, join(ASSETS, 'brand', name));
    res.writeHead(404); res.end(); return;
  }

  // JSON API
  if (path === '/api/projects') {
    const db = openDb();
    try { json(res, getProjects(db)); } finally { db.close(); }
    return;
  }

  if (path === '/api/overview') {
    const db = openDb();
    try { json(res, getOverview(db)); } finally { db.close(); }
    return;
  }

  if (path === '/api/recent') {
    const db = openDb();
    try { json(res, getRecent(db)); } finally { db.close(); }
    return;
  }

  if (path === '/api/search') {
    const q = url.searchParams.get('q') || '';
    if (!q) { json(res, []); return; }
    const db = openDb();
    try { json(res, searchMemories(db, q)); } finally { db.close(); }
    return;
  }

  if (path.startsWith('/api/project/')) {
    const name = decodeURIComponent(path.slice('/api/project/'.length));
    const db = openDb();
    try {
      const data = getProjectMemories(db, name);
      if (data === null) { res.writeHead(404); res.end(); return; }
      json(res, data);
    } finally { db.close(); }
    return;
  }

  if (path.startsWith('/api/memory/')) {
    const id = parseInt(path.slice('/api/memory/'.length), 10);
    const db = openDb();
    try {
      const data = getMemory(db, id);
      if (!data) { res.writeHead(404); res.end(); return; }
      json(res, data);
    } finally { db.close(); }
    return;
  }

  res.writeHead(404); res.end('Not found');
}

function handleSync(res) {
  const proc = spawn(process.execPath, [SYNC_JS], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  proc.on('close', code => {
    res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: code === 0, output: out }));
  });
}
