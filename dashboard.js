#!/usr/bin/env node
// MemoryCentral dashboard web UI — http://localhost:9980
import { createServer } from 'http';
import { openDb } from './server/db.js';

const PORT = 9980;

function getData() {
  const db = openDb();

  const projects = db.prepare(`
    SELECT p.id, p.name, p.description, p.stack, p.last_synced,
           COUNT(m.id) AS mem_count
    FROM projects p
    LEFT JOIN memories m ON m.project_id = p.id
    GROUP BY p.id
    ORDER BY p.name
  `).all();

  const totals = db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS projects, COUNT(m.id) AS memories
    FROM projects p LEFT JOIN memories m ON m.project_id = p.id
  `).get();

  const lastSync = db.prepare(
    `SELECT synced_at FROM sync_events ORDER BY synced_at DESC LIMIT 1`
  ).get();

  db.close();

  return {
    projects: projects.map(p => ({
      ...p,
      stack: JSON.parse(p.stack || '[]'),
      last_synced: p.last_synced ? new Date(p.last_synced).toLocaleString() : '—',
    })),
    totals,
    lastSync: lastSync ? new Date(lastSync.synced_at).toLocaleString() : '—',
  };
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
            <div class="card" data-name="${p.name.toLowerCase()}" data-tags="${p.stack.join(' ')}">
              <div class="card-header">
                <span class="project-name">${p.name}</span>
                <span class="mem-badge" title="${p.mem_count} memories">${p.mem_count}</span>
              </div>
              <p class="desc">${p.description || '<em>No description yet</em>'}</p>
              <div class="tags">
                ${p.stack.map(t => `<span class="tag">${t}</span>`).join('')}
              </div>
              <div class="synced">synced ${p.last_synced}</div>
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
    --border:   #2a2d3a;
    --accent:   #7c6af7;
    --accent2:  #4fc3a1;
    --text:     #e2e4ed;
    --muted:    #6b7280;
    --tag-bg:   #1e2235;
    --badge-bg: #2a2d3a;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 2rem 1.5rem;
  }

  header {
    max-width: 1100px;
    margin: 0 auto 2.5rem;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 1rem;
  }

  header h1 {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.02em;
  }

  .stats {
    display: flex;
    gap: 1.5rem;
    font-size: 0.85rem;
    color: var(--muted);
  }

  .stats strong { color: var(--text); }

  .search-wrap {
    max-width: 1100px;
    margin: 0 auto 2rem;
  }

  #search {
    width: 100%;
    max-width: 360px;
    padding: 0.5rem 0.75rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.15s;
  }
  #search:focus { border-color: var(--accent); }
  #search::placeholder { color: var(--muted); }

  .main { max-width: 1100px; margin: 0 auto; }

  .stack-group { margin-bottom: 2.5rem; }
  .stack-label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin-bottom: 0.75rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0.75rem;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: border-color 0.15s;
  }
  .card:hover { border-color: var(--accent); }
  .card.hidden { display: none; }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .project-name {
    font-weight: 600;
    font-size: 0.95rem;
    color: var(--text);
  }

  .mem-badge {
    font-size: 0.7rem;
    font-weight: 700;
    background: var(--badge-bg);
    color: var(--accent2);
    border-radius: 20px;
    padding: 0.15rem 0.5rem;
    flex-shrink: 0;
  }

  .desc {
    font-size: 0.82rem;
    color: var(--muted);
    line-height: 1.5;
  }
  .desc em { font-style: italic; }

  .tags { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.25rem; }
  .tag {
    font-size: 0.68rem;
    background: var(--tag-bg);
    color: var(--muted);
    border-radius: 4px;
    padding: 0.15rem 0.4rem;
    border: 1px solid var(--border);
  }

  .synced {
    font-size: 0.7rem;
    color: var(--border);
    margin-top: auto;
    padding-top: 0.25rem;
  }

  .stack-group.hidden { display: none; }
  .no-results {
    color: var(--muted);
    font-size: 0.9rem;
    display: none;
    padding: 1rem 0;
  }
  .no-results.visible { display: block; }
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

<div class="search-wrap">
  <input id="search" type="search" placeholder="Filter projects…" autocomplete="off">
</div>

<main class="main" id="main">
  ${stackSections}
  <p class="no-results" id="no-results">No projects match.</p>
</main>

<script>
  const search = document.getElementById('search');
  const noResults = document.getElementById('no-results');

  search.addEventListener('input', () => {
    const q = search.value.toLowerCase().trim();
    let visible = 0;

    document.querySelectorAll('.stack-group').forEach(group => {
      let groupVisible = 0;
      group.querySelectorAll('.card').forEach(card => {
        const match = !q
          || card.dataset.name.includes(q)
          || card.dataset.tags.includes(q)
          || card.querySelector('.desc').textContent.toLowerCase().includes(q);
        card.classList.toggle('hidden', !match);
        if (match) groupVisible++;
      });
      group.classList.toggle('hidden', groupVisible === 0);
      visible += groupVisible;
    });

    noResults.classList.toggle('visible', visible === 0 && q.length > 0);
  });
</script>
</body>
</html>`;
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' || (req.url !== '/' && req.url !== '')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  try {
    const data = getData();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html(data));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Error: ${err.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MemoryCentral dashboard → http://localhost:${PORT}`);
});
