// The dashboard's setup and settings API: onboarding, engine choice, model
// downloads, indexing, and the retention controls (held removals, missing
// folders, recently deleted memories). Routed from dashboard.js, which owns the
// HTTP server and its request checks.
//
// Long operations stream NDJSON — one JSON object per line — so the page can show
// progress: { phase, i, n } / { status, completed, total }, ending in { done } or
// { error }.

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch, release } from 'os';
import { getSetting, setSetting } from './settings.js';
import { activeConfig, invalidateConfig, prepareLocalModel, embed } from './embed.js';
import {
  OLLAMA_MODELS, LOCAL_MODELS, DEFAULT_LOCAL_MODEL, DEFAULT_OLLAMA_HOST, APPLE_SILICON,
  recommendedOllamaModel, canRunOllamaModel, ollamaSpec, isLocalHost,
} from './models.js';
import { countPending, drainPending } from './backlog.js';
import { syncAll, formatSyncStats } from './ingest.js';
import { ADAPTERS, scanSource } from './sources.js';
import { connectSnippets } from './connect.js';
import { suggestBlock, INSTRUCTION_FILES } from './projectBlock.js';
import { confirmHeldRemovals, adoptSource, restoreTombstone, purgeTombstone, deleteMemory } from './store.js';
import { dataRoot } from './paths.js';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

// ── Environment ─────────────────────────────────────────────────────────────

const OLLAMA_INSTALL = {
  darwin: { command: 'brew install ollama', url: 'https://ollama.com/download/mac' },
  win32: { command: 'winget install Ollama.Ollama', url: 'https://ollama.com/download/windows' },
  linux: { command: 'curl -fsSL https://ollama.com/install.sh | sh', url: 'https://ollama.com/download/linux' },
};

export async function ollamaCheck(host = DEFAULT_OLLAMA_HOST) {
  const base = String(host).replace(/\/$/, '');
  try {
    const signal = AbortSignal.timeout(3000);
    const version = await fetch(`${base}/api/version`, { signal }).then(r => r.json());
    const tags = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) }).then(r => r.json());
    return { reachable: true, host: base, version: version.version, models: (tags.models || []).map(m => ({ name: m.name, size: m.size })) };
  } catch (err) {
    return { reachable: false, host: base, error: err?.cause?.code || err?.name || err?.message };
  }
}

const configSummary = cfg => ({
  provider: cfg.provider, host: cfg.host, model: cfg.model, label: cfg.spec.label,
  runnable: cfg.runnable, space: cfg.space, chunkChars: cfg.chunkChars,
});

// What already exists on this machine that MemoryCentral will import.
function harnessInventory() {
  const out = [];
  for (const [kind, adapter] of Object.entries(ADAPTERS)) {
    if (kind === 'dir') continue;
    let projects = 0, memories = 0, error = null;
    try {
      for (const d of adapter.discover()) {
        try { const n = scanSource(d.root).length; if (n) { projects++; memories += n; } } catch {}
      }
    } catch (err) { error = err.message; }
    out.push({ kind, label: adapter.label, projects, memories, error });
  }
  return out;
}

export async function setupStatus(db) {
  const cfg = activeConfig();
  const host = cfg.host;
  const ollama = await ollamaCheck(host);
  const recommended = recommendedOllamaModel(host);
  return {
    completed: !!getSetting(db, 'setup.completed_at'),
    platform: { os: platform(), arch: arch(), release: release(), appleSilicon: APPLE_SILICON, node: process.versions.node },
    config: configSummary(cfg),
    chosen: { provider: getSetting(db, 'embed.provider') ?? null },
    ollama: {
      ...ollama,
      install: OLLAMA_INSTALL[platform()] ?? OLLAMA_INSTALL.linux,
      recommended: { model: recommended, ...ollamaSpec(recommended), installed: !!ollama.models?.some(m => m.name === recommended) },
      options: Object.keys(OLLAMA_MODELS).map(m => ({
        model: m, label: OLLAMA_MODELS[m].label, sizeMB: OLLAMA_MODELS[m].sizeMB,
        runnable: canRunOllamaModel(m, host), installed: !!ollama.models?.some(x => x.name === m),
      })),
    },
    local: {
      recommended: DEFAULT_LOCAL_MODEL,
      options: Object.entries(LOCAL_MODELS).map(([id, s]) => ({ model: id, label: s.label, sizeMB: s.sizeMB })),
    },
    harnesses: harnessInventory(),
    index: {
      projects: db.prepare('SELECT COUNT(*) n FROM projects').get().n,
      memories: db.prepare('SELECT COUNT(*) n FROM memories').get().n,
      pending: countPending(db),
    },
    dataRoot: dataRoot(),
  };
}

// ── Settings ────────────────────────────────────────────────────────────────

export function saveSettings(db, body) {
  const { provider, ollamaHost, ollamaModel, localModel } = body || {};
  if (!['ollama', 'local'].includes(provider)) return { ok: false, reason: 'provider must be "ollama" or "local"' };
  if (provider === 'ollama') {
    const host = String(ollamaHost || DEFAULT_OLLAMA_HOST).replace(/\/$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(host)) return { ok: false, reason: `not a URL: ${host}` };
    const model = ollamaModel || recommendedOllamaModel(host);
    if (!canRunOllamaModel(model, host)) {
      return { ok: false, reason: `${model} is MLX-only and can't run ${isLocalHost(host) ? 'on this machine' : 'on a remote Ollama we can\'t verify'} — use ${recommendedOllamaModel(host)}` };
    }
    setSetting(db, 'ollama.host', host === DEFAULT_OLLAMA_HOST ? null : host);
    setSetting(db, 'embed.ollama.model', model);
  } else {
    const model = localModel || DEFAULT_LOCAL_MODEL;
    if (!LOCAL_MODELS[model]) return { ok: false, reason: `unknown built-in model ${model}` };
    setSetting(db, 'embed.local.model', model);
  }
  setSetting(db, 'embed.provider', provider);
  invalidateConfig();
  return { ok: true, config: configSummary(activeConfig()), pending: countPending(db) };
}

export function completeSetup(db) {
  setSetting(db, 'setup.completed_at', new Date().toISOString());
  return { ok: true };
}

// ── Streams ─────────────────────────────────────────────────────────────────

function ndjson(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  return obj => res.write(JSON.stringify(obj) + '\n');
}

// Pulls through Ollama's own streaming API, so no terminal is needed.
export async function streamOllamaPull(res, { host, model }) {
  const send = ndjson(res);
  const base = String(host || DEFAULT_OLLAMA_HOST).replace(/\/$/, '');
  try {
    if (!canRunOllamaModel(model, base)) throw new Error(`${model} can't run here — use ${recommendedOllamaModel(base)}`);
    const r = await fetch(`${base}/api/pull`, { method: 'POST', body: JSON.stringify({ model, stream: true }) });
    if (!r.ok) throw new Error(`Ollama returned HTTP ${r.status}`);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(ev.error);
        send({ phase: 'pull', status: ev.status, completed: ev.completed, total: ev.total });
      }
    }
    send({ done: true });
  } catch (err) {
    send({ error: err.message });
  }
  res.end();
}

// Downloads (once) and loads a built-in model, then proves it embeds.
export async function streamLocalPrepare(res, { model }) {
  const send = ndjson(res);
  try {
    let last = 0;
    await prepareLocalModel(model || DEFAULT_LOCAL_MODEL, p => {
      if (p.status !== 'progress' || Date.now() - last < 200) return;
      last = Date.now();
      send({ phase: 'download', file: p.file, completed: p.loaded, total: p.total });
    });
    send({ done: true });
  } catch (err) {
    send({ error: err.message });
  }
  res.end();
}

// Imports every source and embeds everything still pending, with progress.
export async function streamIndex(res, db) {
  const send = ndjson(res);
  try {
    const probe = await embed('embedding provider probe');
    if (!probe.ok) send({ warning: `Embedding unavailable (${probe.reason}): ${probe.message}. Memories are imported and keyword-searchable; vectors follow once it works.` });
    const stats = await syncAll(db, { onProgress: send, embed: false });
    if (stats.skipped) { send({ error: 'Another MemoryCentral process is syncing right now — try again in a moment.' }); return res.end(); }
    if (probe.ok) await drainPending(db, () => {}, send);
    stats.pending = countPending(db);
    send({ done: true, summary: formatSyncStats(stats), stats });
  } catch (err) {
    send({ error: err.message });
  }
  res.end();
}

// ── Connecting apps and project blocks ──────────────────────────────────────

export function harnessSnippets() {
  return connectSnippets({
    node: process.execPath,
    server: resolve(SERVER_DIR, 'index.js'),
    sync: resolve(SERVER_DIR, '..', 'sync.js'),
  });
}

export function projectBlocks(db) {
  return {
    files: INSTRUCTION_FILES,
    projects: db.prepare(`
      SELECT p.name, p.description, p.stack, p.repo_path, p.meta_file, COUNT(m.id) AS memories
      FROM projects p LEFT JOIN memories m ON m.project_id = p.id GROUP BY p.id ORDER BY p.name
    `).all().map(p => ({
      name: p.name, repoPath: p.repo_path, blockFile: p.meta_file, memories: p.memories,
      block: suggestBlock({ name: p.name, description: p.description, stack: JSON.parse(p.stack || '[]') }),
    })),
  };
}

// ── Retention controls ──────────────────────────────────────────────────────

export function listSources(db) {
  return db.prepare(`
    SELECT s.id, s.kind, s.root, s.status, s.note, s.last_scan_at, s.last_ok_at, s.missing_since,
           p.name AS project, (SELECT COUNT(*) FROM memories m WHERE m.source_id = s.id) AS memories
    FROM sources s JOIN projects p ON p.id = s.project_id ORDER BY (s.status = 'ok'), p.name
  `).all().map(s => ({ ...s, label: ADAPTERS[s.kind]?.label ?? s.kind }));
}

export function listTombstones(db) {
  return db.prepare(`
    SELECT t.id, t.filename, t.title, t.deleted_at, t.reason, p.name AS project, LENGTH(t.content) AS size
    FROM memory_tombstones t JOIN projects p ON p.id = t.project_id ORDER BY t.deleted_at DESC
  `).all();
}

export const retention = {
  confirm: (db, id) => confirmHeldRemovals(db, id),
  adopt: (db, id) => adoptSource(db, id),
  restore: (db, id) => restoreTombstone(db, id),
  purge: (db, id) => purgeTombstone(db, id),
  deleteMemory: (db, body) => deleteMemory(db, body || {}),
};

