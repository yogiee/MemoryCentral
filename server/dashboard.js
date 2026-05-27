// Dashboard HTTP server — imported by server/index.js (MCP process)
// and by the root dashboard.js standalone runner.
import { createServer } from 'http';
import { openDb } from './db.js';

const TYPE_COLOR = {
  feedback:  '#f59e0b',
  project:   '#3b82f6',
  user:      '#10b981',
  reference: '#8b5cf6',
  general:   '#6b7280',
};

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function getPageData() {
  const db = openDb();

  const projects = db.prepare(`
    SELECT p.id, p.name, p.description, p.stack, p.last_synced,
           COUNT(m.id) AS mem_count
    FROM projects p
    LEFT JOIN memories m ON m.project_id = p.id
    GROUP BY p.id
    ORDER BY p.name
  `).all();

  const typeCounts = db.prepare(`
    SELECT project_id, memory_type, COUNT(*) AS cnt
    FROM memories GROUP BY project_id, memory_type
  `).all();

  const totals = db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS projects, COUNT(m.id) AS memories
    FROM projects p LEFT JOIN memories m ON m.project_id = p.id
  `).get();

  const lastSync = db.prepare(
    `SELECT synced_at FROM sync_events ORDER BY synced_at DESC LIMIT 1`
  ).get();

  db.close();

  const typeMap = {};
  for (const r of typeCounts) {
    if (!typeMap[r.project_id]) typeMap[r.project_id] = {};
    typeMap[r.project_id][r.memory_type] = r.cnt;
  }

  return {
    projects: projects.map(p => ({
      ...p,
      stack: JSON.parse(p.stack || '[]'),
      last_synced: p.last_synced ? new Date(p.last_synced).toLocaleString() : '—',
      types: typeMap[p.id] || {},
    })),
    totals,
    lastSync: lastSync ? new Date(lastSync.synced_at).toLocaleString() : '—',
  };
}

function getRecent(db, limit = 12) {
  return db.prepare(`
    SELECT m.id, m.filename, m.memory_type, m.title, m.synced_at, p.name AS project_name
    FROM memories m JOIN projects p ON p.id = m.project_id
    ORDER BY m.synced_at DESC LIMIT ?
  `).all(limit);
}

function searchMemories(db, q) {
  try {
    return db.prepare(`
      SELECT m.id, m.filename, m.memory_type, m.title, p.name AS project_name,
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
    SELECT id, filename, memory_type, title, synced_at
    FROM memories WHERE project_id=? ORDER BY memory_type, filename
  `).all(p.id);
}

function getMemory(db, id) {
  return db.prepare(`
    SELECT m.id, m.filename, m.memory_type, m.title, m.content, m.synced_at, p.name AS project_name
    FROM memories m JOIN projects p ON p.id = m.project_id
    WHERE m.id=?
  `).get(id);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function renderTypeDots(types) {
  return Object.entries(TYPE_COLOR).map(([t, c]) => {
    const n = types[t] || 0;
    if (!n) return '';
    return `<span class="tdot" style="background:${c}" title="${n} ${t}">${n}</span>`;
  }).join('');
}

function html({ projects, totals, lastSync }) {
  const byStack = {};
  for (const p of projects) {
    const key = p.stack[0] || 'other';
    (byStack[key] = byStack[key] || []).push(p);
  }

  const stackSections = Object.entries(byStack)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, projs]) => `
      <section class="stack-group" data-stack="${tag}">
        <h2 class="stack-label">${tag}</h2>
        <div class="cards">
          ${projs.map(p => `
            <div class="card" data-id="${p.id}" data-name="${p.name.toLowerCase()}" data-tags="${p.stack.join(' ')}"
                 onclick="openProject('${escHtml(p.name)}')">
              <div class="card-header">
                <span class="project-name">${escHtml(p.name)}</span>
                <span class="mem-badge" title="${p.mem_count} ${p.mem_count === 1 ? 'memory' : 'memories'}">${p.mem_count}</span>
              </div>
              <p class="desc">${p.description ? escHtml(p.description) : '<em>No description</em>'}</p>
              <div class="card-footer">
                <div class="tdots">${renderTypeDots(p.types)}</div>
                <div class="tags">${p.stack.map(t => `<span class="tag">${t}</span>`).join('')}</div>
              </div>
              <div class="synced">${p.last_synced}</div>
            </div>
          `).join('')}
        </div>
      </section>
    `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MemoryCentral</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:       #0f1117;
    --surface:  #1a1d27;
    --surface2: #1e2235;
    --border:   #2a2d3a;
    --accent:   #7c6af7;
    --accent2:  #4fc3a1;
    --text:     #e2e4ed;
    --muted:    #6b7280;
    --tag-bg:   #1e2235;
    --badge-bg: #2a2d3a;
    --panel-w:  420px;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 1.5rem 1.25rem;
  }

  header {
    max-width: 1100px;
    margin: 0 auto 1.25rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  header h1 {
    font-size: 1.2rem;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.02em;
  }

  .stats {
    display: flex;
    gap: 1.25rem;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .stats strong { color: var(--text); }

  /* toolbar */
  .toolbar {
    max-width: 1100px;
    margin: 0 auto 1.25rem;
    display: flex;
    gap: 0.6rem;
    align-items: center;
  }

  #search {
    flex: 1;
    max-width: 320px;
    padding: 0.4rem 0.65rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 0.82rem;
    outline: none;
    transition: border-color 0.15s;
  }
  #search:focus { border-color: var(--accent); }
  #search::placeholder { color: var(--muted); }

  .btn-recent {
    font-size: 0.78rem;
    padding: 0.35rem 0.75rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--muted);
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .btn-recent:hover, .btn-recent.active { border-color: var(--accent); color: var(--text); }

  /* recent strip */
  #recent-strip {
    max-width: 1100px;
    margin: 0 auto 1.5rem;
    display: none;
  }
  #recent-strip.visible { display: block; }
  .recent-label {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin-bottom: 0.5rem;
  }
  .recent-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .recent-item {
    font-size: 0.73rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    transition: border-color 0.15s;
  }
  .recent-item:hover { border-color: var(--accent); }
  .recent-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .recent-proj { color: var(--muted); font-size: 0.68rem; }

  /* search results */
  #search-results {
    max-width: 1100px;
    margin: 0 auto 1.5rem;
    display: none;
  }
  #search-results.visible { display: block; }
  .sr-label {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin-bottom: 0.6rem;
  }
  .sr-list { display: flex; flex-direction: column; gap: 0.4rem; }
  .sr-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.55rem 0.75rem;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .sr-item:hover { border-color: var(--accent); }
  .sr-meta { font-size: 0.72rem; color: var(--muted); margin-bottom: 0.2rem; }
  .sr-title { font-size: 0.83rem; font-weight: 600; color: var(--text); margin-bottom: 0.2rem; }
  .sr-excerpt { font-size: 0.75rem; color: var(--muted); line-height: 1.5; }
  .sr-excerpt mark { background: transparent; color: var(--accent2); font-weight: 600; }
  .no-results { color: var(--muted); font-size: 0.85rem; padding: 0.5rem 0; display: none; }
  .no-results.visible { display: block; }

  /* main grid */
  .main { max-width: 1100px; margin: 0 auto; }

  .stack-group { margin-bottom: 2rem; }
  .stack-group.hidden { display: none; }
  .stack-label {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin-bottom: 0.6rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--border);
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0.5rem;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 0.6rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .card:hover { border-color: var(--accent); }
  .card.hidden { display: none; }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }

  .project-name { font-weight: 600; font-size: 0.82rem; color: var(--text); }

  .mem-badge {
    font-size: 0.62rem;
    font-weight: 700;
    background: var(--badge-bg);
    color: var(--accent2);
    border-radius: 20px;
    padding: 0.1rem 0.4rem;
    flex-shrink: 0;
  }

  .desc {
    font-size: 0.74rem;
    color: var(--muted);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .desc em { font-style: italic; }

  .card-footer { display: flex; align-items: center; justify-content: space-between; gap: 0.3rem; flex-wrap: wrap; }
  .tdots { display: flex; gap: 0.25rem; align-items: center; }
  .tdot {
    font-size: 0.58rem;
    font-weight: 700;
    color: #0f1117;
    border-radius: 20px;
    padding: 0.05rem 0.35rem;
    line-height: 1.5;
  }

  .tags { display: flex; flex-wrap: wrap; gap: 0.2rem; }
  .tag {
    font-size: 0.6rem;
    background: var(--tag-bg);
    color: var(--muted);
    border-radius: 3px;
    padding: 0.1rem 0.3rem;
    border: 1px solid var(--border);
  }

  .synced { font-size: 0.62rem; color: var(--border); margin-top: auto; }

  /* side panel */
  .backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.55);
    z-index: 40;
    opacity: 0; pointer-events: none;
    transition: opacity 0.2s;
  }
  .backdrop.open { opacity: 1; pointer-events: auto; }

  .panel {
    position: fixed; top: 0; right: 0; bottom: 0;
    width: var(--panel-w);
    background: var(--surface);
    border-left: 1px solid var(--border);
    z-index: 50;
    display: flex;
    flex-direction: column;
    transform: translateX(100%);
    transition: transform 0.22s ease;
    overflow: hidden;
  }
  .panel.open { transform: translateX(0); }

  .panel-header {
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .panel-back {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
  }
  .panel-back:hover { color: var(--text); background: var(--border); }
  .panel-title { font-weight: 600; font-size: 0.9rem; color: var(--text); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .panel-close {
    background: none; border: none;
    color: var(--muted); cursor: pointer;
    font-size: 1.1rem; line-height: 1;
    padding: 0.1rem 0.3rem; border-radius: 4px;
  }
  .panel-close:hover { color: var(--text); background: var(--border); }

  .panel-body { flex: 1; overflow-y: auto; padding: 0.75rem 1rem; }

  /* memory list in panel */
  .mem-list { display: flex; flex-direction: column; gap: 0.3rem; }
  .mem-item {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    cursor: pointer;
    transition: border-color 0.15s;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .mem-item:hover { border-color: var(--accent); }
  .mem-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .mem-info { flex: 1; min-width: 0; }
  .mem-title { font-size: 0.79rem; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mem-file { font-size: 0.66rem; color: var(--muted); }
  .mem-date { font-size: 0.62rem; color: var(--border); flex-shrink: 0; }

  /* memory content in panel */
  .mem-content {
    font-size: 0.78rem;
    line-height: 1.65;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .mem-content-meta {
    font-size: 0.68rem;
    color: var(--muted);
    margin-bottom: 0.75rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .mem-type-badge {
    font-size: 0.62rem;
    font-weight: 600;
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
    color: #0f1117;
  }

  .loading { color: var(--muted); font-size: 0.82rem; padding: 1rem 0; }
</style>
</head>
<body>
<header>
  <h1>MemoryCentral</h1>
  <div class="stats">
    <span><strong>${totals.projects}</strong> projects</span>
    <span><strong>${totals.memories}</strong> memories</span>
    <span>synced <strong>${lastSync}</strong></span>
  </div>
</header>

<div class="toolbar">
  <input id="search" type="search" placeholder="Search memories…" autocomplete="off">
  <button class="btn-recent" id="btn-recent" onclick="toggleRecent()">Recent</button>
</div>

<div id="recent-strip">
  <div class="recent-label">Recently modified</div>
  <div class="recent-list" id="recent-list"><span class="loading">Loading…</span></div>
</div>

<div id="search-results">
  <div class="sr-label" id="sr-label">Results</div>
  <div class="sr-list" id="sr-list"></div>
  <p class="no-results" id="no-results">No memories match.</p>
</div>

<main class="main" id="main">
  ${stackSections}
</main>

<!-- Side panel -->
<div class="backdrop" id="backdrop" onclick="closePanel()"></div>
<div class="panel" id="panel">
  <div class="panel-header">
    <button class="panel-back" id="panel-back" onclick="panelBack()" style="display:none">←</button>
    <span class="panel-title" id="panel-title">Project</span>
    <button class="panel-close" onclick="closePanel()">✕</button>
  </div>
  <div class="panel-body" id="panel-body"></div>
</div>

<script>
  const TYPE_COLOR = ${JSON.stringify(TYPE_COLOR)};

  // ---- filter (card filter when search is empty) ----
  const searchEl = document.getElementById('search');
  const srSection = document.getElementById('search-results');
  const srList = document.getElementById('sr-list');
  const srLabel = document.getElementById('sr-label');
  const noResults = document.getElementById('no-results');
  const mainEl = document.getElementById('main');

  let searchTimer = null;

  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchEl.value.trim();
    if (!q) {
      srSection.classList.remove('visible');
      mainEl.style.display = '';
      return;
    }
    searchTimer = setTimeout(() => doSearch(q), 250);
  });

  async function doSearch(q) {
    mainEl.style.display = 'none';
    srSection.classList.add('visible');
    srList.innerHTML = '<span class="loading">Searching…</span>';
    noResults.classList.remove('visible');

    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await res.json();

    srLabel.textContent = data.length + ' result' + (data.length !== 1 ? 's' : '') + ' for "' + q + '"';
    if (!data.length) {
      srList.innerHTML = '';
      noResults.classList.add('visible');
      return;
    }
    srList.innerHTML = data.map(r => \`
      <div class="sr-item" onclick="openMemory(\${r.id})">
        <div class="sr-meta">\${r.project_name} / <span style="color:\${TYPE_COLOR[r.memory_type] || '#6b7280'}">\${r.memory_type}</span></div>
        <div class="sr-title">\${esc(r.title)}</div>
        <div class="sr-excerpt">\${r.excerpt}</div>
      </div>
    \`).join('');
  }

  // ---- recent ----
  let recentLoaded = false;
  function toggleRecent() {
    const strip = document.getElementById('recent-strip');
    const btn = document.getElementById('btn-recent');
    const open = strip.classList.toggle('visible');
    btn.classList.toggle('active', open);
    if (open && !recentLoaded) loadRecent();
  }

  async function loadRecent() {
    recentLoaded = true;
    const res = await fetch('/api/recent');
    const data = await res.json();
    const list = document.getElementById('recent-list');
    list.innerHTML = data.map(r => \`
      <div class="recent-item" onclick="openMemory(\${r.id})">
        <span class="recent-dot" style="background:\${TYPE_COLOR[r.memory_type] || '#6b7280'}"></span>
        <span>\${esc(r.title)}</span>
        <span class="recent-proj">\${esc(r.project_name)}</span>
      </div>
    \`).join('') || '<span style="color:var(--muted);font-size:0.8rem">No memories yet.</span>';
  }

  // ---- card filter (local, when search empty) ----
  searchEl.addEventListener('input', () => {
    const q = searchEl.value.toLowerCase().trim();
    if (q) return; // handled by doSearch
    document.querySelectorAll('.stack-group').forEach(group => {
      let vis = 0;
      group.querySelectorAll('.card').forEach(card => {
        const match = !q || card.dataset.name.includes(q) || card.dataset.tags.includes(q)
                      || card.querySelector('.desc').textContent.toLowerCase().includes(q);
        card.classList.toggle('hidden', !match);
        if (match) vis++;
      });
      group.classList.toggle('hidden', vis === 0);
    });
  });

  // ---- panel ----
  let panelStack = []; // [{title, render}]

  function openPanel(title, renderFn) {
    panelStack = [{ title, renderFn }];
    _showPanel();
  }
  function pushPanel(title, renderFn) {
    panelStack.push({ title, renderFn });
    _showPanel();
  }
  function panelBack() {
    panelStack.pop();
    _showPanel();
  }
  function _showPanel() {
    const top = panelStack[panelStack.length - 1];
    document.getElementById('panel-title').textContent = top.title;
    document.getElementById('panel-back').style.display = panelStack.length > 1 ? '' : 'none';
    document.getElementById('panel-body').innerHTML = '<span class="loading">Loading…</span>';
    document.getElementById('panel').classList.add('open');
    document.getElementById('backdrop').classList.add('open');
    top.renderFn(document.getElementById('panel-body'));
  }
  function closePanel() {
    document.getElementById('panel').classList.remove('open');
    document.getElementById('backdrop').classList.remove('open');
    panelStack = [];
  }

  async function openProject(name) {
    openPanel(name, async (body) => {
      const res = await fetch('/api/project/' + encodeURIComponent(name));
      const data = await res.json();
      if (!data || !data.length) { body.innerHTML = '<span class="loading">No memories yet.</span>'; return; }

      const grouped = {};
      for (const m of data) (grouped[m.memory_type] = grouped[m.memory_type] || []).push(m);

      body.innerHTML = Object.entries(grouped).map(([type, items]) => \`
        <div style="margin-bottom:1rem">
          <div style="font-size:0.62rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:\${TYPE_COLOR[type] || '#6b7280'};margin-bottom:.4rem">\${type}</div>
          <div class="mem-list">
            \${items.map(m => \`
              <div class="mem-item" onclick="openMemory(\${m.id})">
                <span class="mem-dot" style="background:\${TYPE_COLOR[m.memory_type] || '#6b7280'}"></span>
                <div class="mem-info">
                  <div class="mem-title">\${esc(m.title)}</div>
                  <div class="mem-file">\${esc(m.filename)}</div>
                </div>
                <div class="mem-date">\${fmtDate(m.synced_at)}</div>
              </div>
            \`).join('')}
          </div>
        </div>
      \`).join('');
    });
  }

  async function openMemory(id) {
    pushPanel('Memory', async (body) => {
      const res = await fetch('/api/memory/' + id);
      const m = await res.json();
      if (!m) { body.innerHTML = '<span class="loading">Not found.</span>'; return; }
      document.getElementById('panel-title').textContent = m.title;
      const color = TYPE_COLOR[m.memory_type] || '#6b7280';
      body.innerHTML = \`
        <div class="mem-content-meta">
          <span class="mem-type-badge" style="background:\${color}">\${m.memory_type}</span>
          <span>\${esc(m.project_name)}</span>
          <span>\${esc(m.filename)}</span>
          <span>\${fmtDate(m.synced_at)}</span>
        </div>
        <pre class="mem-content">\${esc(m.content)}</pre>
      \`;
    });
  }

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
    catch { return iso.slice(0,10); }
  }
</script>
</body>
</html>`;
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export function start(port = 9980, keepAlive = false) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

    // JSON API
    if (url.pathname === '/api/recent') {
      const db = openDb();
      const data = getRecent(db);
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q') || '';
      if (!q) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return; }
      const db = openDb();
      const data = searchMemories(db, q);
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname.startsWith('/api/project/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/project/'.length));
      const db = openDb();
      const data = getProjectMemories(db, name);
      db.close();
      if (data === null) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname.startsWith('/api/memory/')) {
      const id = parseInt(url.pathname.slice('/api/memory/'.length), 10);
      const db = openDb();
      const data = getMemory(db, id);
      db.close();
      if (!data) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    // Dashboard page
    if (url.pathname === '/' || url.pathname === '') {
      try {
        const data = getPageData();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error: ${err.message}`);
      }
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.on('error', err => {
    if (err.code !== 'EADDRINUSE') process.stderr.write(`Dashboard error: ${err.message}\n`);
  });

  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`MemoryCentral dashboard → http://localhost:${port}\n`);
  });

  if (!keepAlive) server.unref();
}
