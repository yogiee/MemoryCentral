'use strict';

// ============================================================
// Constants
// ============================================================
var TYPES = {
  feedback:  { color: 'var(--type-feedback)',  label: 'Feedback'  },
  project:   { color: 'var(--type-project)',   label: 'Project'   },
  user:      { color: 'var(--type-user)',       label: 'User'      },
  reference: { color: 'var(--type-reference)', label: 'Reference' },
  general:   { color: 'var(--type-general)',   label: 'General'   },
};
var TYPE_ORDER = ['project', 'reference', 'user', 'feedback', 'general'];

// ============================================================
// State
// ============================================================
var S = {
  selectedProjectName: null,
  selectedMemoryId: null,
  activeView: 'overview',
  typeFilter: null,
  _projects: [],
  _projectMemories: [],   // current project's memory list
  _recentItems: [],
  _overviewData: null,
};

// ============================================================
// DOM helpers
// ============================================================
var q = function(sel) { return document.querySelector(sel); };

var el = function(tag, attrs) {
  var kids = Array.prototype.slice.call(arguments, 2);
  var n = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function(k) {
      var v = attrs[k];
      if (v === false || v === null || v === undefined) return;
      if (k === 'class') { n.className = v; }
      else if (k === 'html') { n.innerHTML = v; }
      else if (k.indexOf('on') === 0) { n.addEventListener(k.slice(2).toLowerCase(), v); }
      else { n.setAttribute(k, v === true ? '' : v); }
    });
  }
  kids.flat().forEach(function(c) {
    if (c === null || c === undefined || c === false) return;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return n;
};

// ============================================================
// Utilities
// ============================================================
function relTime(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  var diff = Math.floor((Date.now() - d) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function typeColor(type) {
  return TYPES[type] ? TYPES[type].color : 'var(--text-faint)';
}

function mdToHtml(md) {
  if (!md) return '';
  // Strip YAML frontmatter
  md = md.replace(/^---[\s\S]*?---\n?/, '');

  var lines = md.split('\n');
  var out = [];
  var inPre = false;
  var preLines = [];
  var listItems = [];

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inlineMarkup(s) {
    s = esc(s);
    // **bold** / __bold__
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    // *italic* / _italic_
    s = s.replace(/(?<![*_])\*([^*\n]+)\*(?![*])/g, '<em>$1</em>');
    s = s.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>');
    // `code`
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // [text](url) links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    return s;
  }
  function flushList() {
    if (!listItems.length) return;
    var items = listItems.map(function(t) { return '<li>' + inlineMarkup(t) + '</li>'; });
    out.push('<ul>' + items.join('') + '</ul>');
    listItems = [];
  }
  function flushPre() {
    if (!preLines.length) return;
    var code = preLines.map(esc).join('\n');
    out.push('<pre><code>' + code + '</code></pre>');
    preLines = [];
    preLang = '';
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    if (inPre) {
      if (line.match(/^```/)) { inPre = false; flushPre(); }
      else { preLines.push(line); }
      continue;
    }

    if (line.match(/^```/)) {
      flushList();
      inPre = true;
      continue;
    }

    var h3 = line.match(/^### (.+)/);
    var h2 = line.match(/^## (.+)/);
    var h1 = line.match(/^# (.+)/);
    if (h3) { flushList(); out.push('<h3>' + inlineMarkup(h3[1]) + '</h3>'); continue; }
    if (h2) { flushList(); out.push('<h3>' + inlineMarkup(h2[1]) + '</h3>'); continue; }
    if (h1) { flushList(); out.push('<h3>' + inlineMarkup(h1[1]) + '</h3>'); continue; }

    var li = line.match(/^[-*+] (.+)/);
    if (li) { listItems.push(li[1]); continue; }

    var oli = line.match(/^\d+\. (.+)/);
    if (oli) { listItems.push(oli[1]); continue; }

    if (!line.trim()) {
      flushList();
      continue;
    }

    // Bare key: value lines (common in frontmatter-like content)
    flushList();
    out.push('<p>' + inlineMarkup(line) + '</p>');
  }
  flushList();
  if (inPre) flushPre();
  return out.join('\n');
}

// ============================================================
// API
// ============================================================
async function apiFetch(path) {
  var r = await fetch(path);
  if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + path);
  return r.json();
}

// ============================================================
// Layout helpers
// ============================================================
function setHasDetail(yes) {
  q('#content').classList.toggle('no-selection', !yes);
}

function setRailActive(view) {
  document.querySelectorAll('.rail [data-view]').forEach(function(b) {
    b.setAttribute('aria-current', b.dataset.view === view ? 'true' : 'false');
  });
}

function showEmptyDetail(msg) {
  var d = q('#col-detail');
  d.innerHTML = '';
  d.appendChild(el('div', { 'class': 'empty-state' }, msg || 'Pick a memory to read.'));
}

// ============================================================
// Render: Projects column
// ============================================================
function renderProjects() {
  var projects = S._projects;
  var body = q('#projects-body');
  body.innerHTML = '';

  if (!projects.length) {
    body.appendChild(el('div', { 'class': 'empty-state' }, 'No projects yet. Run a sync.'));
    return;
  }

  var groups = {};
  projects.forEach(function(p) {
    var key = (p.stack && p.stack[0]) || 'other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });

  var keys = Object.keys(groups).sort();
  keys.forEach(function(stackKey) {
    var list = groups[stackKey];
    var group = el('div', { 'class': 'stack-group' });
    group.appendChild(el('div', { 'class': 'stack-group-header' },
      el('span', { 'class': 'stack-line' }),
      stackKey,
      el('span', { 'class': 'count' }, '' + list.length)
    ));
    list.forEach(function(p) {
      var card = el('button', {
        'class': 'project-card',
        'aria-selected': S.selectedProjectName === p.name ? 'true' : 'false',
        'onclick': function() { selectProject(p.name); },
      });
      card.appendChild(el('div', { 'class': 'project-top' },
        el('span', { 'class': 'project-name' }, p.name),
        el('span', { 'class': 'project-count' }, '' + (p.memCount || 0))
      ));
      if (p.description) {
        card.appendChild(el('p', { 'class': 'project-desc' }, p.description));
      } else {
        card.appendChild(el('p', { 'class': 'project-desc unknown' }, '_unknown_'));
      }
      // type dots + modified
      var dots = el('span', { 'class': 'type-dots' });
      TYPE_ORDER.forEach(function(t) {
        var cnt = (p.types && p.types[t]) || 0;
        if (cnt > 0) {
          dots.appendChild(el('span', {
            'class': 'dot',
            'style': 'background:' + typeColor(t),
            'title': cnt + ' ' + t,
          }));
        }
      });
      card.appendChild(el('div', { 'class': 'project-meta' },
        dots,
        el('span', { 'class': 'modified' }, relTime(p.lastSynced))
      ));
      // stack tags (first 4)
      if (p.stack && p.stack.length) {
        var tagsEl = el('div', { 'class': 'stack-tags' });
        p.stack.slice(0, 4).forEach(function(t) {
          tagsEl.appendChild(el('span', { 'class': 'tag' }, t));
        });
        card.appendChild(tagsEl);
      }
      group.appendChild(card);
    });
    body.appendChild(group);
  });

  var totalMems = projects.reduce(function(a, p) { return a + (p.memCount || 0); }, 0);
  q('#projects-meta').textContent = projects.length + ' projects · ' + totalMems + ' memories';
}

// ============================================================
// Render: Overview (col 2 + col 3 hidden)
// ============================================================
function renderOverview(data) {
  S.activeView = 'overview';
  setHasDetail(false);
  setRailActive('overview');
  q('#search-input').value = '';

  var mid = q('#col-memories');
  mid.innerHTML = '';

  var totalMems = data.memories || 0;
  var byType = data.byType || {};
  var byStack = data.byStack || [];
  var maxStack = byStack.reduce(function(a, r) { return Math.max(a, r.count); }, 1);
  var spark = data.sparkSessions || [];

  var ov = el('div', { 'class': 'overview' });

  // Left pane
  var main = el('div', { 'class': 'overview-main' });
  main.appendChild(el('div', { 'class': 'overview-eyebrow' }, 'Overview'));
  main.appendChild(el('h1', { 'class': 'overview-title' }, 'Knowledge across all projects'));
  main.appendChild(el('p', { 'class': 'overview-sub' }, 'Everything Claude has remembered, across every project on this machine. Pick a project at left, or jump in via search.'));

  // Stat tiles
  var stats = el('div', { 'class': 'stats' });
  stats.appendChild(statTile('Projects', '' + (data.projects || 0), S._projects.length + ' tracked', null));
  stats.appendChild(statTile('Memories', '' + totalMems, data.sessions14d + ' sync sessions', spark));
  stats.appendChild(statTile('Sessions /14d', '' + (data.sessions14d || 0), 'via Stop hook', spark));
  stats.appendChild(statTile('Last sync', data.lastSync ? relTime(data.lastSync) : '—', 'auto after session', null));
  main.appendChild(stats);

  // By-stack bars
  if (byStack.length) {
    var stackPanel = el('div', { 'class': 'ov-panel' });
    stackPanel.appendChild(el('div', { 'class': 'panel-head' },
      el('div', { 'class': 'panel-title' }, 'Memories by primary stack'),
      el('div', { 'class': 'panel-sub' }, byStack.length + ' groups')
    ));
    var bars = el('div', { 'class': 'bars' });
    byStack.forEach(function(r) {
      var pct = maxStack > 0 ? (r.count / maxStack) * 100 : 0;
      bars.appendChild(el('div', { 'class': 'bar-row' },
        el('span', { 'class': 'bar-label' }, r.stack),
        el('div', { 'class': 'bar-track' },
          el('div', { 'class': 'bar-fill', 'style': 'width:' + pct + '%' })
        ),
        el('span', { 'class': 'bar-count' }, '' + r.count)
      ));
    });
    stackPanel.appendChild(bars);
    main.appendChild(stackPanel);
  }

  // By-type breakdown
  var typePanel = el('div', { 'class': 'ov-panel' });
  typePanel.appendChild(el('div', { 'class': 'panel-head' },
    el('div', { 'class': 'panel-title' }, 'Memories by type'),
    el('div', { 'class': 'panel-sub' }, totalMems + ' total')
  ));
  var breakdown = el('div', { 'class': 'type-breakdown' });
  var stack = el('div', { 'class': 'type-stack' });
  TYPE_ORDER.forEach(function(t) {
    var cnt = byType[t] || 0;
    if (cnt > 0 && totalMems > 0) {
      stack.appendChild(el('div', {
        'style': 'flex:' + cnt + ';background:' + typeColor(t),
      }));
    }
  });
  breakdown.appendChild(stack);
  var blist = el('div', { 'class': 'breakdown-list' });
  TYPE_ORDER.forEach(function(t) {
    var cnt = byType[t] || 0;
    var pct = totalMems > 0 ? Math.round((cnt / totalMems) * 100) : 0;
    blist.appendChild(el('div', { 'class': 'breakdown-row' },
      el('span', { 'class': 'swatch', 'style': 'background:' + typeColor(t) }),
      el('span', { 'class': 'name' }, TYPES[t] ? TYPES[t].label : t),
      el('span', { 'class': 'pct' }, pct + '%'),
      el('span', { 'class': 'count' }, '' + cnt)
    ));
  });
  breakdown.appendChild(blist);
  typePanel.appendChild(breakdown);
  main.appendChild(typePanel);

  // Right pane
  var side = el('div', { 'class': 'overview-side' });

  side.appendChild(el('div', { 'class': 'panel-head' },
    el('div', { 'class': 'panel-title' }, 'Recent activity'),
    el('div', { 'class': 'panel-sub' }, 'last ' + (data.recent ? data.recent.length : 0))
  ));
  var act = el('div', { 'class': 'activity' });
  (data.recent || []).forEach(function(r) {
    var row = el('div', { 'class': 'activity-row',
      'onclick': function() { selectMemoryFromId(r.id, r.project_name); },
    });
    row.appendChild(el('span', { 'class': 'swatch', 'style': 'background:' + typeColor(r.memory_type) }));
    var info = el('div', {});
    info.appendChild(el('div', { 'class': 'activity-title' }, r.filename));
    info.appendChild(el('div', { 'class': 'activity-meta' }, r.project_name));
    row.appendChild(info);
    row.appendChild(el('div', { 'class': 'activity-time' }, relTime(r.synced_at)));
    act.appendChild(row);
  });
  side.appendChild(act);

  side.appendChild(el('div', { 'class': 'side-section-head' },
    el('div', { 'class': 'panel-head' },
      el('div', { 'class': 'panel-title' }, 'Embeddings tier'),
      el('div', { 'class': 'panel-sub' }, 'auto-detected')
    )
  ));
  var tiers = el('div', { 'class': 'tier-list' });
  var tier = data.tier || 3;
  [
    ['Ollama · nomic-embed-text', 'tier 1', tier === 1],
    ['transformers.js · MiniLM-L6', 'fallback', tier === 2],
    ['In-context Claude matching', 'fallback', tier === 3],
  ].forEach(function(row) {
    var rowEl = el('div', { 'class': 'tier-row ' + (row[2] ? 'active' : 'inactive') });
    var check = el('div', { 'class': 'tier-check' });
    if (row[2]) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '10'); svg.setAttribute('height', '10'); svg.setAttribute('viewBox', '0 0 10 10');
      svg.innerHTML = '<polyline points="2 5 4.5 7.5 8 3" fill="none" stroke="currentColor" stroke-width="1.5"/>';
      check.appendChild(svg);
    }
    rowEl.appendChild(check);
    rowEl.appendChild(el('span', { 'class': 'tier-name' }, row[0]));
    rowEl.appendChild(el('span', { 'class': 'tier-tag' }, row[1]));
    tiers.appendChild(rowEl);
  });
  side.appendChild(tiers);

  ov.appendChild(main);
  ov.appendChild(side);
  mid.appendChild(ov);
  q('#col-detail').innerHTML = '';
}

function statTile(label, value, foot, sparkData) {
  var tile = el('div', { 'class': 'stat' });
  tile.appendChild(el('div', { 'class': 'stat-label' }, label));
  tile.appendChild(el('div', { 'class': 'stat-value' }, value));
  tile.appendChild(el('div', { 'class': 'stat-foot' }, foot));
  if (sparkData && sparkData.length) {
    var max = Math.max.apply(null, sparkData.concat([1]));
    var sparkEl = el('div', { 'class': 'spark' });
    sparkData.forEach(function(v) {
      sparkEl.appendChild(el('div', { 'class': 'b', 'style': 'height:' + Math.round((v / max) * 100) + '%' }));
    });
    tile.appendChild(sparkEl);
  }
  return tile;
}

// ============================================================
// Render: Memories list (col 2 — project mode)
// ============================================================
function renderMemoriesList(projectName, memories) {
  S._projectMemories = memories;
  var mid = q('#col-memories');
  mid.innerHTML = '';

  // Build type counts from current list
  var typeCounts = {};
  memories.forEach(function(m) { typeCounts[m.memory_type] = (typeCounts[m.memory_type] || 0) + 1; });

  // Header
  var header = el('div', { 'class': 'col-header' });
  header.appendChild(el('h2', {}, projectName));
  var filters = el('div', { 'class': 'filters' });
  TYPE_ORDER.forEach(function(t) {
    var cnt = typeCounts[t] || 0;
    if (!cnt) return;
    var pill = el('button', {
      'class': 'filter-pill',
      'aria-pressed': S.typeFilter === t ? 'true' : 'false',
      'onclick': function() {
        S.typeFilter = S.typeFilter === t ? null : t;
        renderMemoriesList(projectName, memories);
      },
    });
    pill.appendChild(el('span', { 'class': 'swatch', 'style': 'background:' + typeColor(t) }));
    pill.appendChild(document.createTextNode('' + cnt));
    filters.appendChild(pill);
  });
  header.appendChild(filters);
  mid.appendChild(header);

  var body = el('div', { 'class': 'col-body' });
  var filtered = S.typeFilter ? memories.filter(function(m) { return m.memory_type === S.typeFilter; }) : memories;

  // Group by type
  var groups = {};
  filtered.forEach(function(m) {
    if (!groups[m.memory_type]) groups[m.memory_type] = [];
    groups[m.memory_type].push(m);
  });

  if (!filtered.length) {
    body.appendChild(el('div', { 'class': 'empty-state' }, 'No memories of that type.'));
  } else {
    TYPE_ORDER.forEach(function(t) {
      var list = groups[t];
      if (!list || !list.length) return;
      var secHead = el('div', { 'class': 'mem-section-header' });
      secHead.appendChild(el('span', { 'class': 'swatch', 'style': 'background:' + typeColor(t) }));
      secHead.appendChild(document.createTextNode(TYPES[t] ? TYPES[t].label : t));
      secHead.appendChild(el('span', { 'class': 'count' }, '' + list.length));
      body.appendChild(secHead);

      list.forEach(function(m) {
        var row = el('button', {
          'class': 'mem-row',
          'aria-selected': S.selectedMemoryId === m.id ? 'true' : 'false',
          'onclick': function() { selectMemory(m.id); },
        });
        row.appendChild(el('div', { 'class': 'mem-title' },
          el('span', { 'class': 'swatch', 'style': 'background:' + typeColor(m.memory_type) }),
          el('span', { 'class': 'name' }, m.filename)
        ));
        if (m.excerpt) {
          row.appendChild(el('div', { 'class': 'mem-preview' }, m.excerpt.slice(0, 200)));
        }
        row.appendChild(el('div', { 'class': 'mem-meta' },
          el('span', {}, relTime(m.synced_at)),
          el('span', {}, fmtSize(m.size_bytes))
        ));
        body.appendChild(row);
      });
    });
  }
  mid.appendChild(body);
}

// ============================================================
// Render: Memory detail (col 3)
// ============================================================
function renderMemoryDetail(mem) {
  // Update selection in memories list
  document.querySelectorAll('#col-memories .mem-row').forEach(function(r) {
    r.setAttribute('aria-selected', r.dataset.memId === '' + mem.id ? 'true' : 'false');
  });

  var detail = q('#col-detail');
  detail.innerHTML = '';

  var head = el('div', { 'class': 'detail-head' });
  var eyebrow = el('div', { 'class': 'detail-eyebrow' });
  eyebrow.appendChild(el('span', { 'class': 'swatch', 'style': 'background:' + typeColor(mem.memory_type) }));
  eyebrow.appendChild(document.createTextNode(TYPES[mem.memory_type] ? TYPES[mem.memory_type].label : mem.memory_type));
  eyebrow.appendChild(el('span', { 'class': 'sep' }, ' / '));
  eyebrow.appendChild(document.createTextNode(mem.project_name));
  head.appendChild(eyebrow);
  head.appendChild(el('h2', { 'class': 'detail-title' }, mem.filename));
  var path = '~/.claude/projects/' + (mem.encoded_path || mem.project_name) + '/memory/' + mem.filename;
  head.appendChild(el('div', { 'class': 'detail-meta' },
    el('span', {}, el('b', {}, 'Modified'), relTime(mem.synced_at)),
    el('span', {}, el('b', {}, 'Size'), fmtSize(mem.size_bytes)),
    el('span', {}, el('b', {}, 'Path'), path)
  ));
  detail.appendChild(head);

  // Actions bar
  var actions = el('div', { 'class': 'detail-actions' });
  actions.appendChild(actionBtn('Open in editor', iconEdit(), function() {
    // Use the server-side /api/open route or just copy path
    alert('Path: ' + path);
  }));
  actions.appendChild(actionBtn('Copy path', iconCopy(), function() {
    navigator.clipboard.writeText(path).catch(function() {});
  }));
  actions.appendChild(actionBtn('Find similar', iconSparkles(), function() {
    q('#search-input').value = mem.title || mem.filename.replace(/\.[^.]+$/, '');
    q('#search-input').dispatchEvent(new Event('input'));
    q('#search-input').focus();
  }));
  actions.appendChild(el('span', { 'class': 'spacer' }));
  actions.appendChild(actionBtn('Delete', iconTrash(), function() {
    if (confirm('Delete ' + mem.filename + '? This cannot be undone.')) {
      fetch('/api/memory/' + mem.id, { method: 'DELETE' }).then(function() {
        boot();
      });
    }
  }, true));
  detail.appendChild(actions);

  var body = el('div', { 'class': 'detail-body', 'html': mdToHtml(mem.content) });
  detail.appendChild(body);
}

function actionBtn(label, svgEl, handler, danger) {
  var b = el('button', {
    'class': danger ? 'danger' : '',
    'onclick': handler,
  });
  b.appendChild(svgEl);
  b.appendChild(document.createTextNode(' ' + label));
  return b;
}
function mkSvg(inner) {
  var d = document.createElement('span');
  d.innerHTML = inner;
  return d.firstChild;
}
function iconEdit()     { return mkSvg('<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/></svg>'); }
function iconCopy()     { return mkSvg('<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>'); }
function iconSparkles() { return mkSvg('<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2"/></svg>'); }
function iconTrash()    { return mkSvg('<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>'); }

// ============================================================
// Render: Search results (col 2)
// ============================================================
function renderSearchResults(searchQ, results) {
  S.activeView = 'search';
  setHasDetail(true);
  setRailActive(null);

  var mid = q('#col-memories');
  mid.innerHTML = '';
  var header = el('div', { 'class': 'col-header' });
  header.appendChild(el('h2', {}, 'Search results'));
  header.appendChild(el('span', { 'class': 'meta' }, results.length + ' for "' + searchQ + '"'));
  mid.appendChild(header);

  var body = el('div', { 'class': 'col-body' });
  if (!results.length) {
    body.appendChild(el('div', { 'class': 'empty-state' }, 'No matches for "' + searchQ + '"'));
  } else {
    results.forEach(function(r) {
      var row = el('button', { 'class': 'mem-row', 'data-mem-id': '' + r.id,
        'aria-selected': S.selectedMemoryId === r.id ? 'true' : 'false',
        'onclick': function() { selectMemoryFromId(r.id, r.project_name); },
      });
      row.appendChild(el('div', { 'class': 'mem-title' },
        el('span', { 'class': 'swatch', 'style': 'background:' + typeColor(r.memory_type) }),
        el('span', { 'class': 'name' }, r.filename)
      ));
      // excerpt with <mark> highlights from server
      var preview = el('div', { 'class': 'mem-preview', 'html': r.excerpt || '' });
      row.appendChild(preview);
      row.appendChild(el('div', { 'class': 'mem-meta' },
        el('span', {}, r.project_name),
        el('span', {}, relTime(r.synced_at))
      ));
      body.appendChild(row);
    });
  }
  mid.appendChild(body);
  showEmptyDetail('Pick a result to read.');
}

// ============================================================
// Render: Recent view (col 2)
// ============================================================
function renderRecentView(items) {
  S._recentItems = items;
  S.activeView = 'recent';
  setHasDetail(false);
  setRailActive('recent');

  var mid = q('#col-memories');
  mid.innerHTML = '';
  var header = el('div', { 'class': 'col-header' });
  header.appendChild(el('h2', {}, 'Recent activity'));
  header.appendChild(el('span', { 'class': 'meta' }, 'last ' + items.length));
  mid.appendChild(header);

  var body = el('div', { 'class': 'col-body' });
  if (!items.length) {
    body.appendChild(el('div', { 'class': 'empty-state' }, 'No memories yet.'));
  } else {
    items.forEach(function(r) {
      var row = el('button', { 'class': 'mem-row', 'data-mem-id': '' + r.id,
        'aria-selected': S.selectedMemoryId === r.id ? 'true' : 'false',
        'onclick': function() { selectMemoryFromId(r.id, r.project_name); },
      });
      row.appendChild(el('div', { 'class': 'mem-title' },
        el('span', { 'class': 'swatch', 'style': 'background:' + typeColor(r.memory_type) }),
        el('span', { 'class': 'name' }, r.filename)
      ));
      if (r.excerpt) {
        row.appendChild(el('div', { 'class': 'mem-preview' }, r.excerpt.slice(0, 200)));
      }
      row.appendChild(el('div', { 'class': 'mem-meta' },
        el('span', {}, relTime(r.synced_at)),
        el('span', {}, TYPES[r.memory_type] ? TYPES[r.memory_type].label : r.memory_type)
      ));
      body.appendChild(row);
    });
  }
  mid.appendChild(body);
}

// ============================================================
// Selection
// ============================================================
async function selectProject(name) {
  S.selectedProjectName = name;
  S.selectedMemoryId = null;
  S.typeFilter = null;
  S.activeView = 'project';
  setHasDetail(true);
  setRailActive(null);
  q('#search-input').value = '';
  renderProjects();
  showEmptyDetail('Loading…');

  var memories = await apiFetch('/api/project/' + encodeURIComponent(name));
  renderMemoriesList(name, memories);

  // Mark mem-row data attrs for selection tracking
  document.querySelectorAll('#col-memories .mem-row').forEach(function(r, i) {
    r.dataset.memId = memories[i] ? '' + memories[i].id : '';
  });

  if (memories.length) {
    await selectMemory(memories[0].id);
  } else {
    showEmptyDetail('No memories in this project.');
  }
}

async function selectMemory(id) {
  S.selectedMemoryId = id;
  setHasDetail(true);
  // Update aria-selected on all mem-rows
  document.querySelectorAll('#col-memories .mem-row').forEach(function(r) {
    r.setAttribute('aria-selected', r.dataset.memId === '' + id ? 'true' : 'false');
  });
  var mem = await apiFetch('/api/memory/' + id);
  renderMemoryDetail(mem);
}

async function selectMemoryFromId(id, _projectName) {
  S.selectedMemoryId = id;
  setHasDetail(true);
  if (S.activeView === 'recent') {
    // Keep recent list visible but show detail
    q('#content').classList.remove('no-selection');
    document.querySelectorAll('#col-memories .mem-row').forEach(function(r) {
      r.setAttribute('aria-selected', r.dataset.memId === '' + id ? 'true' : 'false');
    });
  } else if (S.activeView === 'search') {
    document.querySelectorAll('#col-memories .mem-row').forEach(function(r) {
      r.setAttribute('aria-selected', r.dataset.memId === '' + id ? 'true' : 'false');
    });
  }
  var mem = await apiFetch('/api/memory/' + id);
  renderMemoryDetail(mem);
}

// ============================================================
// Theme
// ============================================================
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('.theme-toggle button').forEach(function(b) {
    b.setAttribute('aria-pressed', b.dataset.themeSet === t ? 'true' : 'false');
  });
  try { localStorage.setItem('mc-theme', t); } catch (e) {}
}

document.querySelectorAll('.theme-toggle button').forEach(function(b) {
  b.addEventListener('click', function() { applyTheme(b.dataset.themeSet); });
});

// ============================================================
// Rail
// ============================================================
document.querySelectorAll('.rail [data-view]').forEach(function(b) {
  b.addEventListener('click', async function() {
    var v = b.dataset.view;
    if (v === 'overview') {
      S.selectedProjectName = null;
      S.selectedMemoryId = null;
      setHasDetail(false);
      renderProjects();
      if (S._overviewData) {
        renderOverview(S._overviewData);
      } else {
        q('#col-memories').innerHTML = '<div class="empty-state">Loading…</div>';
        var data = await apiFetch('/api/overview');
        S._overviewData = data;
        renderOverview(data);
      }
    } else if (v === 'recent') {
      S.selectedProjectName = null;
      S.selectedMemoryId = null;
      setHasDetail(false);
      renderProjects();
      q('#col-memories').innerHTML = '<div class="empty-state">Loading…</div>';
      var items = await apiFetch('/api/recent');
      renderRecentView(items);
      // mark data-mem-id on rows
      document.querySelectorAll('#col-memories .mem-row').forEach(function(r, i) {
        r.dataset.memId = items[i] ? '' + items[i].id : '';
      });
    }
  });
});

// Sync button
q('#rail-sync').addEventListener('click', async function() {
  q('#sync-label').textContent = 'syncing…';
  try {
    await fetch('/api/sync', { method: 'POST' });
    S._overviewData = null;
    S._projects = [];
    await boot();
  } catch (e) {
    q('#sync-label').textContent = 'error';
  }
});

// ============================================================
// Search (debounced)
// ============================================================
var searchTimer = null;
q('#search-input').addEventListener('input', function() {
  var v = this.value.trim();
  S.searchQuery = v;
  clearTimeout(searchTimer);
  if (!v) {
    // Restore previous view
    if (S.selectedProjectName && S.activeView !== 'recent') {
      // Kept already — just clear detail unless project view is showing
    }
    if (S.activeView === 'search' || !S.selectedProjectName) {
      S.activeView = 'overview';
      setHasDetail(false);
      setRailActive('overview');
      renderProjects();
      if (S._overviewData) renderOverview(S._overviewData);
      else apiFetch('/api/overview').then(function(d) { S._overviewData = d; renderOverview(d); });
    }
    return;
  }
  searchTimer = setTimeout(async function() {
    var results = await apiFetch('/api/search?q=' + encodeURIComponent(v));
    renderSearchResults(v, results);
    // tag mem-rows with data-mem-id
    document.querySelectorAll('#col-memories .mem-row').forEach(function(r, i) {
      r.dataset.memId = results[i] ? '' + results[i].id : '';
    });
  }, 250);
});

// ============================================================
// Keyboard
// ============================================================
document.addEventListener('keydown', function(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    q('#search-input').focus();
    q('#search-input').select();
  }
  if (e.key === 'Escape' && document.activeElement === q('#search-input')) {
    q('#search-input').value = '';
    q('#search-input').dispatchEvent(new Event('input'));
    q('#search-input').blur();
  }
});

// ============================================================
// Boot
// ============================================================
async function boot() {
  applyTheme(localStorage.getItem('mc-theme') || 'system');
  q('#host-pill').textContent = window.location.host;
  try {
    var results = await Promise.all([
      apiFetch('/api/projects'),
      apiFetch('/api/overview'),
    ]);
    S._projects = results[0];
    S._overviewData = results[1];
    renderProjects();
    renderOverview(S._overviewData);
    if (S._overviewData.lastSync) {
      q('#sync-label').textContent = relTime(S._overviewData.lastSync);
    }
  } catch (e) {
    q('#projects-body').innerHTML = '<div class="empty-state">Failed to load: ' + e.message + '</div>';
  }
}

boot();
