import { join } from 'path';
import { chunkText, CHUNK_CHARS } from './chunk.js';
import { getSetting, setSetting } from './settings.js';
import { dataRoot } from './paths.js';
import {
  ollamaSpec, localSpec, vectorSpace, canRunOllamaModel, recommendedOllamaModel,
  DEFAULT_LOCAL_MODEL, DEFAULT_OLLAMA_HOST, MODELS_REVISION,
} from './models.js';

// ── Which embedder, resolved per call ───────────────────────────────────────
//
// The engine ("provider"), model and Ollama host are settings in the shared DB
// (settings.js), chosen during onboarding. Every process re-reads them on a short
// TTL, so a change made on the dashboard reaches every harness's MCP server within
// seconds — no restart, and no stale process re-embedding the table back to the
// old model (which a module-level constant made possible until 2026-10-09).
//
// Precedence: environment variable > DB setting > platform default (models.js).
//   EMBED_PROVIDER   'ollama' | 'local'
//   EMBED_MODEL      Ollama model tag
//   EMBED_LOCAL_MODEL built-in model id
//   OLLAMA_HOST      Ollama base URL
//
// The engine is never switched automatically on failure: vectors from different
// models live in different spaces, and a silent fallback once stranded rows that
// find_similar could no longer see (2026-07-10). A failing engine leaves memories
// pending; backlog.js embeds them once it works again.

let settingsDb = null;
let cached = null;
let cachedAt = 0;
const CONFIG_TTL_MS = Number(process.env.MC_CONFIG_TTL_MS) || 10_000;

// Long-lived processes (MCP server, dashboard) hand over their DB handle so the
// embedder can follow the shared settings. Without one, env + defaults apply.
export function useSettingsDb(db) {
  settingsDb = db;
  cached = null;
}

export function invalidateConfig() { cached = null; }

const VALID_PROVIDERS = ['ollama', 'local'];

export function activeConfig() {
  if (cached && Date.now() - cachedAt < CONFIG_TTL_MS) return cached;
  const setting = key => { try { return settingsDb ? getSetting(settingsDb, key) : undefined; } catch { return undefined; } };
  const env = process.env;
  const provider = [env.EMBED_PROVIDER, setting('embed.provider')].find(v => VALID_PROVIDERS.includes(v)) ?? 'ollama';
  const host = String(env.OLLAMA_HOST || setting('ollama.host') || DEFAULT_OLLAMA_HOST).replace(/\/$/, '');
  let spec, runnable = true;
  if (provider === 'local') {
    spec = localSpec(env.EMBED_LOCAL_MODEL || setting('embed.local.model') || DEFAULT_LOCAL_MODEL);
  } else {
    spec = ollamaSpec(env.EMBED_MODEL || setting('embed.ollama.model') || recommendedOllamaModel(host));
    runnable = canRunOllamaModel(spec.id, host);
  }
  // Code-level revision check (models.js MODELS_REVISION). Newer code claims the
  // shared DB; older code marks itself stale and stops embedding until restarted.
  let stale = false;
  if (settingsDb) {
    const recorded = Number(setting('embed.revision') ?? 0);
    if (MODELS_REVISION > recorded) { try { setSetting(settingsDb, 'embed.revision', MODELS_REVISION); } catch {} }
    else if (MODELS_REVISION < recorded) stale = true;
  }
  cached = {
    provider, host, model: spec.id, spec, runnable, stale,
    space: vectorSpace(provider, spec),
    chunkChars: spec.chunkChars ?? CHUNK_CHARS,
  };
  cachedAt = Date.now();
  return cached;
}

// The vector space every stored vector must match under the active settings.
// The pending-embedding backlog is defined against this (backlog.js).
export function activeModel() {
  return activeConfig().space;
}

// Frames text the way a model was trained to see it. `query` is a search string;
// `document` is a chunk body plus its memory's title. Without a kind the text
// passes through untouched (provider probes). A model without prompts gets
// chunk.js's plain form, so it embeds exactly what it always did.
function frame(text, { kind, title } = {}, spec) {
  if (kind === 'query') return spec.query ? spec.query + text : text;
  if (kind === 'document') return spec.doc ? spec.doc(title, text) : chunkText(title, text);
  return text;
}

// Max input chars per embed. Raised 2000→6000 with the emb-gemma switch — sits inside
// emb-gemma's clean ~8k-char (2048-tok) window, capturing long-memory body content that
// the old 2000 cap truncated away. Centralized here so all callers stay consistent.
export const EMBED_MAX_CHARS = Number(process.env.EMBED_MAX_CHARS) || 6000;

// Abort budget for one embed call. Raised 10s -> 30s on 2026-08-28 after the
// cold-start hypothesis (defect 4 of the backlog-gaps report) was finally
// measured rather than assumed. Worst observed case, repeated: an embed issued
// while gemma4:e4b-mlx (8.5 GB, then the sync-time extraction model) is
// cold-loading — which is exactly what a sync did, since extraction and the embed
// pass ran in the same run — takes 4.4-5.3s against the old 10s budget.
//
//   embedder warm, GPU idle                       50-205ms
//   embedder cold, GPU idle                       ~1.2s
//   embedder resident, big model cold-loading     ~370ms
//   embedder cold,     big model cold-loading     4.4-5.3s   <- the budget case
//
// 1.9x headroom on an idle machine is thin by this project's own standard: the
// same reasoning raised the extraction budget off 30s, where 19% headroom let a
// busy GPU look like a dead pin. 30s keeps ~6x. The cost of the larger budget is
// bounded — embedMemory stops at its first failed chunk, and drainPending gives
// up after 3 consecutive failures — and a genuinely absent provider still fails
// instantly with ECONNREFUSED rather than waiting out the clock.
export const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS) || 30_000;

// How long Ollama keeps the embedder resident after a call. The measurements
// above make this the higher-leverage half of the fix: keeping the model loaded
// collapses the worst case from ~4.5s to ~370ms, a 12x cut, because the dominant
// cost is the embedder's own cold load competing with the big model's, not the
// GPU contention itself.
//
// Sent per request rather than via the server-wide OLLAMA_KEEP_ALIVE, which
// would also pin the extract model in memory. The embedder is the model on the
// hot path, and it is cheap to keep: v2 bf16 settles at 0.73 GB. v1 is not as
// cheap — llama.cpp keeps the buffers it grew for the longest input, so it holds
// ~2.4 GB for the whole keep-alive (measured 2026-10-09).
export const EMBED_KEEP_ALIVE = process.env.EMBED_KEEP_ALIVE ?? '30m';

// Carries a machine-readable reason alongside the human message, so callers can
// tell a missing model from a stopped service without parsing prose.
class EmbedError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'EmbedError';
    this.reason = reason;
  }
}

// ── Tier 1: Ollama ──────────────────────────────────────────────────────────

// Uses the modern /api/embed endpoint with truncate:true — the legacy
// /api/embeddings endpoint ERRORS ("input length exceeds the context length")
// on token-dense content instead of truncating, which is exactly how 5 memories
// ended up silently embedded by the old MiniLM fallback (found 2026-07-10):
// 6000 chars of code/URLs can exceed emb-gemma's 2048-token window even though
// typical prose fits. /api/embed truncates to the context window server-side.
async function ollamaEmbed(text, cfg) {
  let res;
  try {
    res = await fetch(`${cfg.host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model, input: text, truncate: true, keep_alive: EMBED_KEEP_ALIVE,
        ...(cfg.spec.options && { options: cfg.spec.options }),
      }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
  } catch (err) {
    // fetch rejects both when nothing is listening and when the abort fires.
    // Those are opposite problems — "start Ollama" vs "Ollama is thinking too
    // long" — and collapsing them is how a cold-load stall reads as a dead
    // service. Keep them apart.
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new EmbedError('timeout',
        `no response in ${EMBED_TIMEOUT_MS}ms — ${cfg.model} may be cold-loading behind a larger model (raise EMBED_TIMEOUT_MS)`);
    }
    // The useful detail lives on err.cause (ECONNREFUSED, ENOTFOUND, a TLS
    // failure); err.message is a uniformly useless "fetch failed".
    const detail = err?.cause?.code || err?.cause?.message || err?.message || 'unknown';
    throw new EmbedError('provider_down', `cannot reach Ollama at ${cfg.host} (${detail})`);
  }

  if (!res.ok) {
    // A pulled-out model 404s here. That exact failure killed two pins of the
    // old extraction model silently (llama3.1, gemma4:latest) and was read both
    // times as "Ollama isn't running" — name the tag and the fix instead.
    if (res.status === 404) {
      throw new EmbedError('model_missing', `${cfg.model} is not installed — ollama pull ${cfg.model}`);
    }
    const body = await res.text().then(t => t.slice(0, 200).trim()).catch(() => '');
    throw new EmbedError('http_error', `Ollama returned HTTP ${res.status} for ${cfg.model}${body ? ` — ${body}` : ''}`);
  }

  const { embeddings } = await res.json().catch(() => ({}));
  if (!embeddings?.[0]?.length) {
    throw new EmbedError('bad_response', `Ollama returned no vector for ${cfg.model}`);
  }
  return { vector: embeddings[0], model: cfg.space };
}

// ── Engine "local": transformers.js, in-process (no service required) ──────
//
// Models download once into <data root>/models. Each is tokenised at its trained
// window and pooled the way its sentence-transformers config says; a model whose
// ONNX export carries its own pooling head returns `sentence_embedding` directly.

const loaded = new Map(); // model id → Promise<{ run }>

export function prepareLocalModel(id, onProgress = () => {}) {
  if (loaded.has(id)) return loaded.get(id);
  const spec = localSpec(id);
  const p = (async () => {
    const { env, AutoTokenizer, AutoModel } = await import('@huggingface/transformers');
    env.cacheDir = join(dataRoot(), 'models');
    const opts = { progress_callback: onProgress };
    const tokenizer = await AutoTokenizer.from_pretrained(spec.hf, opts);
    const model = await AutoModel.from_pretrained(spec.hf, { ...opts, dtype: spec.dtype });
    async function run(text) {
      const inputs = await tokenizer([text], { padding: true, truncation: true, max_length: spec.maxTokens });
      const out = await model(inputs);
      if (spec.head) return Array.from(out[spec.head].data);
      const h = out.last_hidden_state, [, T, H] = h.dims, data = h.data;
      const v = new Array(H).fill(0);
      if (spec.pooling === 'cls') {
        for (let k = 0; k < H; k++) v[k] = data[k];
      } else {
        const mask = inputs.attention_mask.data;
        let n = 0;
        for (let t = 0; t < T; t++) {
          if (!Number(mask[t])) continue;
          n++;
          for (let k = 0; k < H; k++) v[k] += data[t * H + k];
        }
        for (let k = 0; k < H; k++) v[k] /= n || 1;
      }
      return v;
    }
    return { run };
  })();
  // A failed load (usually the first-run download) must be retryable.
  p.catch(() => loaded.delete(id));
  loaded.set(id, p);
  return p;
}

async function localEmbed(text, cfg) {
  let m;
  try {
    m = await prepareLocalModel(cfg.model);
  } catch (err) {
    // Usually a failed first-run download, which has nothing to do with a
    // provider being "down".
    throw new EmbedError('local_load_failed', `could not load ${cfg.model}: ${err?.message || err}`);
  }
  const v = await m.run(text);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return { vector: v.map(x => x / norm), model: cfg.space };
}

// ── Public API ───────────────────────────────────────────────────────────────

// Returns { ok: true, vector, model } or { ok: false, reason, message }.
// Callers must handle failure gracefully — the memory stays pending, never
// embedded with a different model.
//
// Every failure used to collapse into a bare `null` and a caller-side string
// reading `provider "ollama" unavailable`. On 2026-08-28 that string was printed
// while Ollama was demonstrably healthy, and because it named no cause it was
// believed: 14 memories' vectors went stale behind it before anyone looked.
// A failure now always says which of these it was, and always says it out loud:
//
//   provider_down     nothing listening at OLLAMA_BASE
//   timeout           no response within EMBED_TIMEOUT_MS (cold load?)
//   model_missing     404 — the pinned tag is not installed
//   http_error        any other non-2xx, with the response body
//   bad_response      2xx with no usable vector
//   model_unsupported the configured Ollama model can't run on this machine (MLX off Apple Silicon)
//   stale_code        this process runs older code than the shared DB's embedding revision
//   local_load_failed transformers.js could not load the model
//   unexpected        anything not anticipated here — still reported, never eaten
//
// `opts.kind` is 'query' (find_similar) or 'document' (a chunk body, with
// `opts.title`) — see frame(). Queries and documents must be framed by the same
// convention or they land in different spaces, so every caller states which it is.
// `opts.config` pins one activeConfig() snapshot across several calls (embedMemory
// uses it so all of a memory's chunks land in the same space even if the settings
// change mid-memory).
export async function embed(text, opts = {}) {
  const cfg = opts.config ?? activeConfig();
  const input = frame(String(text), opts, cfg.spec).slice(0, EMBED_MAX_CHARS);
  try {
    if (cfg.stale) {
      throw new EmbedError('stale_code',
        'a newer MemoryCentral changed the embedding setup — restart (or reconnect) this app\'s MemoryCentral server');
    }
    if (!cfg.runnable) {
      throw new EmbedError('model_unsupported',
        `${cfg.model} is an MLX model, which Ollama only runs on Apple Silicon — use ${recommendedOllamaModel(cfg.host)} here`);
    }
    const { vector, model } = cfg.provider === 'local' ? await localEmbed(input, cfg) : await ollamaEmbed(input, cfg);
    return { ok: true, vector, model };
  } catch (err) {
    const reason  = err instanceof EmbedError ? err.reason : 'unexpected';
    const message = err?.message || String(err);
    process.stderr.write(`embed [${reason}]: ${message}\n`);
    return { ok: false, reason, message };
  }
}

export function cosineSimilarity(a, b) {
  let dot = 0, mA = 0, mB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    mA  += a[i] * a[i];
    mB  += b[i] * b[i];
  }
  return dot / (Math.sqrt(mA) * Math.sqrt(mB));
}
