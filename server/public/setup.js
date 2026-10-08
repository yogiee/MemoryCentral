'use strict';

// ============================================================
// Onboarding + Settings
//
// Loaded before app.js; uses its DOM helpers (el, q, apiFetch, relTime) at call
// time. Onboarding is a full-page flow shown until setup is completed (and
// re-openable from Settings to change engine, connect apps or copy project
// blocks). Every write carries this page's token (see dashboard.js).
// ============================================================

var MC_TOKEN = (document.querySelector('meta[name="mc-token"]') || {}).content || '';

async function apiPost(path, body) {
  var r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MC-Token': MC_TOKEN },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 403) throw new Error('This page is out of date — reload it.');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// POST that streams NDJSON events: onEvent(obj) per line. Resolves with the last event.
async function streamPost(path, body, onEvent) {
  var r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MC-Token': MC_TOKEN },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(r.status === 403 ? 'This page is out of date — reload it.' : 'HTTP ' + r.status);
  var reader = r.body.getReader(), decoder = new TextDecoder(), buf = '', last = null;
  for (;;) {
    var part = await reader.read();
    if (part.done) break;
    buf += decoder.decode(part.value, { stream: true });
    var nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      var line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      last = JSON.parse(line);
      onEvent(last);
    }
  }
  return last;
}

function fmtMB(bytes) { return bytes ? (bytes / 1e6).toFixed(0) + ' MB' : ''; }

function copyButton(text) {
  var b = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Copy');
  b.addEventListener('click', function() {
    navigator.clipboard.writeText(text).then(function() {
      b.textContent = 'Copied';
      setTimeout(function() { b.textContent = 'Copy'; }, 1400);
    });
  });
  return b;
}

function codeBlock(label, text) {
  return el('div', { class: 'code-block' },
    el('div', { class: 'code-head' }, el('span', {}, label), copyButton(text)),
    el('pre', {}, text));
}

function progressBar() {
  var fill = el('div', { class: 'progress-fill' });
  var label = el('div', { class: 'progress-label' }, '');
  var wrap = el('div', { class: 'progress' }, el('div', { class: 'progress-track' }, fill), label);
  wrap.set = function(frac, text) {
    wrap.classList.add('active');
    fill.style.width = Math.max(0, Math.min(1, frac || 0)) * 100 + '%';
    label.textContent = text || '';
  };
  return wrap;
}

function notice(kind, text) { return el('div', { class: 'notice notice-' + kind }, text); }

// ============================================================
// Onboarding
// ============================================================

var STEPS = [
  { id: 'welcome', title: 'Welcome' },
  { id: 'engine', title: 'Search engine' },
  { id: 'configure', title: 'Set up engine' },
  { id: 'index', title: 'Import & index' },
  { id: 'connect', title: 'Connect your apps' },
  { id: 'blocks', title: 'Project blocks' },
];

var MCSetup = (function() {
  var O = { status: null, step: 0, choice: null, overlay: null, mode: 'onboarding', onClose: null };

  function open(opts) {
    opts = opts || {};
    O.mode = opts.mode || 'onboarding';
    O.onClose = opts.onClose || null;
    O.step = Math.max(0, STEPS.findIndex(function(s) { return s.id === (opts.step || 'welcome'); }));
    if (O.overlay) O.overlay.remove();
    O.overlay = el('div', { class: 'setup-overlay', role: 'dialog', 'aria-label': 'MemoryCentral setup' });
    document.body.appendChild(O.overlay);
    refreshStatus().then(render);
  }

  function close() {
    if (O.overlay) O.overlay.remove();
    O.overlay = null;
    if (O.onClose) O.onClose();
  }

  async function refreshStatus() {
    O.status = await apiFetch('/api/setup/status');
    if (!O.choice) O.choice = O.status.chosen.provider || (O.status.ollama.reachable ? 'ollama' : null);
    return O.status;
  }

  function go(i) { O.step = i; render(); }

  function render() {
    var s = O.status;
    var nav = el('ol', { class: 'setup-steps' }, STEPS.map(function(st, i) {
      return el('li', { class: i === O.step ? 'current' : i < O.step ? 'done' : '' },
        el('span', { class: 'step-num' }, String(i + 1)), st.title);
    }));
    var body = el('div', { class: 'setup-body' });
    var view = VIEWS[STEPS[O.step].id](s, body);
    if (view) body.appendChild(view);
    O.overlay.innerHTML = '';
    O.overlay.appendChild(el('div', { class: 'setup-frame' },
      el('aside', { class: 'setup-side' },
        el('div', { class: 'setup-brand' }, 'MemoryCentral'),
        el('div', { class: 'setup-side-sub' }, O.mode === 'onboarding' ? 'First-time setup' : 'Settings'),
        nav,
        O.mode !== 'onboarding' ? el('button', { class: 'btn btn-ghost', onclick: close }, 'Back to dashboard') : null),
      body));
  }

  function footer(opts) {
    return el('div', { class: 'setup-footer' },
      O.step > 0 ? el('button', { class: 'btn btn-ghost', onclick: function() { go(O.step - 1); } }, 'Back') : el('span'),
      opts.next === false ? el('span') :
        el('button', { class: 'btn btn-primary', disabled: opts.disabled ? true : null, onclick: opts.onNext || function() { go(O.step + 1); } },
          opts.nextLabel || 'Continue'));
  }

  var VIEWS = {
    welcome: function(s) {
      var found = s.harnesses.filter(function(h) { return h.memories > 0; });
      return el('div', {},
        el('h1', {}, O.mode === 'onboarding' ? 'Set up MemoryCentral' : 'MemoryCentral'),
        el('p', { class: 'lead' }, 'One memory for every project and every AI tool you use. Decisions, fixes and gotchas saved in one tool become searchable from all the others.'),
        el('div', { class: 'card-grid' },
          el('div', { class: 'card' },
            el('div', { class: 'card-label' }, 'This machine'),
            el('div', { class: 'card-value' }, ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[s.platform.os] || s.platform.os),
            el('div', { class: 'card-foot' }, s.platform.arch + (s.platform.appleSilicon ? ' · Apple Silicon' : '') + ' · Node ' + s.platform.node)),
          el('div', { class: 'card' },
            el('div', { class: 'card-label' }, 'Existing memories found'),
            el('div', { class: 'card-value' }, String(found.reduce(function(n, h) { return n + h.memories; }, 0))),
            el('div', { class: 'card-foot' }, found.length
              ? found.map(function(h) { return h.label + ': ' + h.projects + ' projects'; }).join(' · ')
              : 'None yet — new memories start here')),
          el('div', { class: 'card' },
            el('div', { class: 'card-label' }, 'Data folder'),
            el('div', { class: 'card-value card-mono' }, s.dataRoot),
            el('div', { class: 'card-foot' }, 'Index and memories MemoryCentral owns'))),
        found.length ? el('p', { class: 'muted' }, 'Existing memories are imported where they are — files stay in each tool\'s own folder, and anything those tools write later keeps flowing in.') : null,
        footer({}));
    },

    engine: function(s) {
      var o = s.ollama;
      function option(id, title, badge, lines, extra) {
        var card = el('label', { class: 'choice' + (O.choice === id ? ' selected' : '') },
          el('input', { type: 'radio', name: 'engine', value: id, checked: O.choice === id ? true : null,
            onchange: function() { O.choice = id; render(); } }),
          el('div', { class: 'choice-body' },
            el('div', { class: 'choice-title' }, title, badge ? el('span', { class: 'badge' }, badge) : null),
            el('ul', { class: 'choice-points' }, lines.map(function(l) { return el('li', {}, l); })),
            extra || null));
        return card;
      }
      var ollamaStatus = o.reachable
        ? notice('ok', 'Ollama ' + o.version + ' is running at ' + o.host.replace(/^https?:\/\//, '') + '.')
        : el('div', {},
            notice('warn', 'Ollama isn\'t running at ' + o.host.replace(/^https?:\/\//, '') + '.'),
            codeBlock('Install it (' + ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[s.platform.os] + ')', o.install.command),
            el('div', { class: 'row' },
              el('a', { href: o.install.url, target: '_blank', rel: 'noopener' }, 'Or download from ollama.com'),
              el('button', { class: 'btn btn-ghost btn-sm', onclick: function() { refreshStatus().then(render); } }, 'Re-check')));
      return el('div', {},
        el('h1', {}, 'Choose a search engine'),
        el('p', { class: 'lead' }, 'Keyword search always works. Semantic search — finding memories by meaning — needs an embedding engine. You can switch later; MemoryCentral re-indexes automatically.'),
        option('ollama', 'Ollama', o.reachable ? 'Recommended' : null, [
          'Best search quality, especially for finding a specific fact inside a long memory.',
          'Runs as a separate app and uses your GPU. One-time model download of about ' + Math.round(o.recommended.sizeMB) + ' MB.',
          'Can be on another machine on your network.',
        ], ollamaStatus),
        option('local', 'Built-in (Node.js)', o.reachable ? null : 'No install', [
          'Nothing else to install: runs inside MemoryCentral on your CPU.',
          'Smaller one-time download; good for trying MemoryCentral or locked-down machines.',
          'Lower quality on specific facts. Switch to Ollama any time.',
        ]),
        footer({ disabled: !O.choice || (O.choice === 'ollama' && !o.reachable) }));
    },

    configure: function(s) {
      return O.choice === 'local' ? configureLocal(s) : configureOllama(s);
    },

    index: function(s) {
      var bar = progressBar(), out = el('div', {}), btn;
      var already = s.index.memories;
      btn = el('button', { class: 'btn btn-primary', onclick: run }, already ? 'Re-scan and index' : 'Import and index');
      async function run() {
        btn.disabled = true;
        out.innerHTML = '';
        bar.set(0, 'Starting…');
        try {
          var last = await streamPost('/api/index', {}, function(ev) {
            if (ev.phase === 'scan') bar.set(ev.i / ev.n, 'Reading ' + ev.project + ' (' + ev.i + ' of ' + ev.n + ')');
            else if (ev.phase === 'embed') bar.set(ev.i / ev.n, 'Indexing for semantic search — ' + ev.i + ' of ' + ev.n);
            else if (ev.warning) out.appendChild(notice('warn', ev.warning));
          });
          if (last && last.error) throw new Error(last.error);
          bar.set(1, 'Done');
          out.appendChild(el('pre', { class: 'summary' }, last.summary));
          await refreshStatus();
          nextBtn.disabled = false;
        } catch (e) {
          out.appendChild(notice('error', e.message));
        }
        btn.disabled = false;
      }
      var foot = footer({ disabled: !already });
      var nextBtn = foot.querySelector('.btn-primary');
      return el('div', {},
        el('h1', {}, 'Import and index'),
        el('p', { class: 'lead' }, 'Reads every memory folder MemoryCentral knows about and indexes it. After this, MemoryCentral keeps itself current — it re-reads every few minutes while any connected app is open.'),
        el('div', { class: 'row' }, btn,
          already ? el('span', { class: 'muted' }, already + ' memories across ' + s.index.projects + ' projects indexed' + (s.index.pending ? ' · ' + s.index.pending + ' waiting for semantic indexing' : '')) : null),
        bar, out, foot);
    },

    connect: function() {
      var wrap = el('div', {}, el('h1', {}, 'Connect your apps'),
        el('p', { class: 'lead' }, 'Register MemoryCentral once in each AI tool you use. The paths below are this machine\'s; copy them as they are.'),
        el('div', { class: 'empty-state' }, 'Loading…'));
      apiFetch('/api/connect').then(function(list) {
        wrap.querySelector('.empty-state').remove();
        list.forEach(function(h, i) {
          var d = el('details', { class: 'connect', open: i === 0 ? true : null },
            el('summary', {}, h.name),
            el('p', { class: 'muted' }, h.note),
            h.steps.map(function(st) { return codeBlock(st.label, st.text); }));
          wrap.appendChild(d);
        });
        wrap.appendChild(el('p', { class: 'muted' }, 'Restart (or reload the MCP servers of) an app after adding it. Setting it up in any other tool is standard MCP configuration — see that tool\'s documentation.'));
        wrap.appendChild(footer({}));
      });
      return wrap;
    },

    blocks: function() {
      var wrap = el('div', {}, el('h1', {}, 'Project blocks'),
        el('p', { class: 'lead' }, 'A short block in a project\'s instructions file tells MemoryCentral the project\'s name, description and stack — and tells the AI tool working in it to use MemoryCentral.'),
        el('div', { class: 'muted' }, 'Put it in the file your tool reads: CLAUDE.md (Claude Code), AGENTS.md (Codex, OpenCode), .github/copilot-instructions.md (Copilot) or GEMINI.md. Optional, but it is how a project gets a description.'),
        el('div', { class: 'empty-state' }, 'Loading…'));
      apiFetch('/api/project-blocks').then(function(data) {
        wrap.querySelector('.empty-state').remove();
        var list = el('div', { class: 'block-list' });
        data.projects.forEach(function(p) {
          list.appendChild(el('details', { class: 'block-item' },
            el('summary', {},
              el('span', { class: 'block-name' }, p.name),
              el('span', { class: 'chip ' + (p.blockFile ? 'chip-ok' : 'chip-muted') }, p.blockFile ? 'in ' + p.blockFile : 'no block'),
              el('span', { class: 'muted' }, p.memories + ' memories')),
            p.repoPath ? el('div', { class: 'muted card-mono' }, p.repoPath) : null,
            codeBlock('Suggested block', p.block)));
        });
        wrap.appendChild(list);
        wrap.appendChild(footer({
          nextLabel: O.mode === 'onboarding' ? 'Finish' : 'Done',
          onNext: async function() {
            if (O.mode === 'onboarding') await apiPost('/api/setup/complete');
            close();
          },
        }));
      });
      return wrap;
    },
  };

  function configureOllama(s) {
    var o = s.ollama, out = el('div', {});
    var picked = (s.config.provider === 'ollama' && s.config.model) || o.recommended.model;
    var hostInput = el('input', { class: 'input', value: o.host, spellcheck: 'false' });
    var list = el('div', { class: 'model-list' }, o.options.map(function(m) {
      return el('label', { class: 'model' + (m.runnable ? '' : ' disabled') },
        el('input', { type: 'radio', name: 'model', value: m.model, disabled: m.runnable ? null : true,
          checked: m.model === picked ? true : null, onchange: function() { picked = m.model; } }),
        el('span', { class: 'model-name' }, m.label),
        el('span', { class: 'muted card-mono' }, m.model),
        m.model === o.recommended.model ? el('span', { class: 'badge' }, 'Recommended here') : null,
        !m.runnable ? el('span', { class: 'chip chip-muted' }, 'Apple Silicon only') : null,
        el('span', { class: 'chip ' + (m.installed ? 'chip-ok' : 'chip-muted') }, m.installed ? 'installed' : fmtMB(m.sizeMB * 1e6) + ' download'));
    }));
    var bar = progressBar();
    var btn = el('button', { class: 'btn btn-primary', onclick: async function() {
      btn.disabled = true; out.innerHTML = '';
      try {
        var host = hostInput.value.trim();
        var installed = (await apiFetch('/api/ollama/check?host=' + encodeURIComponent(host))).models || [];
        if (!installed.some(function(m) { return m.name === picked; })) {
          var last = await streamPost('/api/ollama/pull', { host: host, model: picked }, function(ev) {
            if (ev.total) bar.set(ev.completed / ev.total, ev.status + ' — ' + fmtMB(ev.completed) + ' of ' + fmtMB(ev.total));
            else if (ev.status) bar.set(0, ev.status);
          });
          if (last && last.error) throw new Error(last.error);
        }
        var r = await apiPost('/api/settings', { provider: 'ollama', ollamaHost: host, ollamaModel: picked });
        if (!r.ok) throw new Error(r.reason);
        bar.set(1, 'Ready: ' + r.config.label);
        await refreshStatus();
        go(O.step + 1);
      } catch (e) {
        out.appendChild(notice('error', e.message));
        btn.disabled = false;
      }
    } }, 'Use this model');
    return el('div', {},
      el('h1', {}, 'Set up Ollama'),
      el('p', { class: 'lead' }, 'Pick the embedding model. Models that can\'t run on this machine are greyed out.'),
      el('div', { class: 'field' }, el('label', {}, 'Ollama address'), hostInput,
        el('div', { class: 'muted' }, 'Change only if Ollama runs on another machine. A remote Ollama gets the model that runs everywhere.')),
      list, el('div', { class: 'row' }, btn), bar, out,
      footer({ next: false }));
  }

  function configureLocal(s) {
    var out = el('div', {}), bar = progressBar();
    var picked = (s.config.provider === 'local' && s.config.model) || s.local.recommended;
    var list = el('div', { class: 'model-list' }, s.local.options.map(function(m) {
      return el('label', { class: 'model' },
        el('input', { type: 'radio', name: 'lmodel', value: m.model, checked: m.model === picked ? true : null,
          onchange: function() { picked = m.model; } }),
        el('span', { class: 'model-name' }, m.label),
        m.model === s.local.recommended ? el('span', { class: 'badge' }, 'Recommended') : null,
        el('span', { class: 'chip chip-muted' }, m.sizeMB + ' MB download'));
    }));
    var btn = el('button', { class: 'btn btn-primary', onclick: async function() {
      btn.disabled = true; out.innerHTML = '';
      try {
        var last = await streamPost('/api/local/prepare', { model: picked }, function(ev) {
          if (ev.total) bar.set(ev.completed / ev.total, 'Downloading ' + (ev.file || '') + ' — ' + fmtMB(ev.completed) + ' of ' + fmtMB(ev.total));
        });
        if (last && last.error) throw new Error(last.error);
        var r = await apiPost('/api/settings', { provider: 'local', localModel: picked });
        if (!r.ok) throw new Error(r.reason);
        bar.set(1, 'Ready: ' + r.config.label);
        await refreshStatus();
        go(O.step + 1);
      } catch (e) {
        out.appendChild(notice('error', e.message));
        btn.disabled = false;
      }
    } }, 'Download and use');
    return el('div', {},
      el('h1', {}, 'Set up the built-in engine'),
      el('p', { class: 'lead' }, 'The model downloads once into MemoryCentral\'s data folder and runs on your CPU.'),
      list, el('div', { class: 'row' }, btn), bar, out,
      footer({ next: false }));
  }

  return { open: open, close: close };
})();

// ============================================================
// Settings view (rail)
// ============================================================

async function renderSettingsView(container) {
  container.innerHTML = '';
  var page = el('div', { class: 'settings' });
  container.appendChild(page);
  var status = await apiFetch('/api/setup/status');
  var c = status.config;

  page.appendChild(el('div', { class: 'overview-eyebrow' }, 'Settings'));
  page.appendChild(el('h1', { class: 'overview-title' }, 'MemoryCentral'));

  page.appendChild(el('section', { class: 'ov-panel' },
    el('div', { class: 'panel-head' }, el('div', { class: 'panel-title' }, 'Search engine'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: function() {
        MCSetup.open({ mode: 'settings', step: 'engine', onClose: function() { renderSettingsView(container); } });
      } }, 'Change…')),
    el('div', { class: 'kv' },
      el('span', {}, 'Engine'), el('span', {}, c.provider === 'local' ? 'Built-in (Node.js)' : 'Ollama · ' + c.host.replace(/^https?:\/\//, '')),
      el('span', {}, 'Model'), el('span', {}, c.label + (c.runnable ? '' : ' — can\'t run on this machine')),
      el('span', {}, 'Index'), el('span', {}, status.index.memories + ' memories · ' +
        (status.index.pending ? status.index.pending + ' waiting for semantic indexing' : 'fully indexed'))),
    !c.runnable ? notice('error', 'The configured model can\'t run here. Choose another with "Change…".') : null));

  page.appendChild(el('section', { class: 'ov-panel' },
    el('div', { class: 'panel-head' }, el('div', { class: 'panel-title' }, 'Apps and projects')),
    el('div', { class: 'row' },
      el('button', { class: 'btn btn-ghost', onclick: function() { MCSetup.open({ mode: 'settings', step: 'connect', onClose: function() { renderSettingsView(container); } }); } }, 'Connect your apps'),
      el('button', { class: 'btn btn-ghost', onclick: function() { MCSetup.open({ mode: 'settings', step: 'blocks', onClose: function() { renderSettingsView(container); } }); } }, 'Project blocks'))));

  // Sources: where memories come from, and anything needing a decision.
  var sources = await apiFetch('/api/sources');
  var STATUS = {
    ok: ['chip-ok', 'OK'], suspect: ['chip-warn', 'Held'], missing: ['chip-muted', 'Folder gone'], unavailable: ['chip-warn', 'Unreadable'],
  };
  var attention = sources.filter(function(s) { return s.status !== 'ok'; });
  page.appendChild(el('section', { class: 'ov-panel' },
    el('div', { class: 'panel-head' }, el('div', { class: 'panel-title' }, 'Memory sources'),
      el('div', { class: 'panel-sub' }, sources.length + ' folders' + (attention.length ? ' · ' + attention.length + ' need attention' : ''))),
    el('p', { class: 'muted' }, 'Nothing is removed because a folder went missing or couldn\'t be read. Removals only happen when a file is deleted from a folder that otherwise reads fine — and when many files vanish at once, they are held here until you confirm.'),
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Project'), el('th', {}, 'Source'), el('th', {}, 'Status'), el('th', {}, 'Memories'), el('th', {}, ''))),
      el('tbody', {}, sources.map(function(s) {
        var st = STATUS[s.status] || ['chip-muted', s.status];
        var action = null;
        if (s.status === 'suspect') action = el('button', { class: 'btn btn-ghost btn-sm', onclick: async function() {
          var r = await apiPost('/api/sources/' + s.id + '/confirm');
          if (r.ok) renderSettingsView(container);
        } }, 'Confirm removals');
        if (s.status === 'missing') action = el('button', { class: 'btn btn-ghost btn-sm', onclick: async function() {
          var r = await apiPost('/api/sources/' + s.id + '/adopt');
          if (r.ok) renderSettingsView(container);
        } }, 'Keep in MemoryCentral');
        return el('tr', {},
          el('td', {}, s.project),
          el('td', { title: s.root }, s.label),
          el('td', {}, el('span', { class: 'chip ' + st[0], title: s.note || '' }, st[1]), s.note ? el('div', { class: 'muted small' }, s.note) : null),
          el('td', { class: 'num' }, String(s.memories)),
          el('td', {}, action));
      })))));

  var orphans = await apiFetch('/api/orphans');
  if (orphans.length) page.appendChild(el('section', { class: 'ov-panel' },
    el('div', { class: 'panel-head' }, el('div', { class: 'panel-title' }, 'Memories without a file'),
      el('div', { class: 'panel-sub' }, orphans.length + ' kept in the index')),
    el('p', { class: 'muted' }, 'These are in MemoryCentral but no folder holds their file any more — renamed or removed before MemoryCentral tracked sources, or by hand. They stay searchable until you decide.'),
    el('table', { class: 'table' },
      el('tbody', {}, orphans.map(function(m) {
        return el('tr', {},
          el('td', {}, m.project), el('td', { class: 'card-mono' }, m.filename), el('td', { class: 'muted' }, m.title),
          el('td', {},
            el('button', { class: 'btn btn-ghost btn-sm', onclick: async function() { var r = await apiPost('/api/orphans/' + m.id + '/adopt'); if (r.ok) renderSettingsView(container); else alert(r.reason); } }, 'Keep'),
            el('button', { class: 'btn btn-ghost btn-sm', onclick: async function() { var r = await apiPost('/api/memory/delete', { project: m.project, filename: m.filename }); if (r.ok) renderSettingsView(container); } }, 'Delete')));
      })))));

  var tombs = await apiFetch('/api/tombstones');
  page.appendChild(el('section', { class: 'ov-panel' },
    el('div', { class: 'panel-head' }, el('div', { class: 'panel-title' }, 'Recently deleted'),
      el('div', { class: 'panel-sub' }, 'kept 30 days')),
    tombs.length ? el('table', { class: 'table' },
      el('tbody', {}, tombs.map(function(t) {
        return el('tr', {},
          el('td', {}, t.project), el('td', { class: 'card-mono' }, t.filename),
          el('td', { class: 'muted' }, relTime(t.deleted_at)),
          el('td', {},
            el('button', { class: 'btn btn-ghost btn-sm', onclick: async function() { var r = await apiPost('/api/tombstones/' + t.id + '/restore'); if (r.ok) renderSettingsView(container); } }, 'Restore'),
            el('button', { class: 'btn btn-ghost btn-sm', onclick: async function() { var r = await apiPost('/api/tombstones/' + t.id + '/purge'); if (r.ok) renderSettingsView(container); } }, 'Delete forever')));
      })))
      : el('p', { class: 'muted' }, 'Nothing deleted recently.')));
}
