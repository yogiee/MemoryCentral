import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir, cpus } from 'os';
import { chunkText } from './chunk.js';

const OLLAMA_BASE = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '');

// Tier-1 embedding model. Override via EMBED_MODEL. The default depends on where
// Ollama runs, because the better model only exists as MLX:
//
//   Apple Silicon + local Ollama   embeddinggemma-2:270m-bf16-text
//   everything else                embeddinggemma:300m (GGUF — Windows, Linux, Intel Mac)
//
// v2 bf16 chosen 2026-10-09 on our own A/B (docs/embedding-eval-2026-10-09.md): same
// topic/gist recall as v1, +0.06-0.08 MRR on specific facts, and it settles at
// 0.73 GB where v1 holds 2.37 GB for as long as it is loaded. Every embeddinggemma-2
// tag is MLX, which Ollama runs only on Apple Silicon — so a default that ignored the
// platform would hand Windows users a model that cannot load. A remote OLLAMA_HOST
// gets the GGUF model too: we can't see the platform it runs on, and v1 runs anywhere.
// v1 history: chosen 2026-06-13 over nomic and granite-embedding:30m
// (docs/embedding-eval-2026-06-13.md).
const OLLAMA_IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(OLLAMA_BASE);
// arch alone misreads an x64 Node running under Rosetta; the CPU name doesn't.
export const APPLE_SILICON = process.platform === 'darwin' &&
  (process.arch === 'arm64' || /Apple/.test(cpus()[0]?.model ?? ''));
export const DEFAULT_EMBED_MODEL = APPLE_SILICON && OLLAMA_IS_LOCAL
  ? 'embeddinggemma-2:270m-bf16-text'
  : 'embeddinggemma:300m';
export const EMBED_MODEL = process.env.EMBED_MODEL ?? DEFAULT_EMBED_MODEL;

// What each model family needs on the wire. `prompts` = the task prefixes the model
// was trained with (queries `task: search result | query: `, documents
// `title: … | text: …`). They measurably help v2 and are mixed on v1, so v1 keeps
// plain text — which also leaves every existing v1 table valid. v2 must send
// num_ctx: without it Ollama cuts inputs over 8,192 tokens to 2,048 (BenchLLAMA
// 2026-10-08). Unknown models (an EMBED_MODEL override) get plain text, no options.
const PROFILES = [
  { match: /^embeddinggemma-2:/, prompts: true, options: { num_ctx: 8192 } },
];
const PROFILE = PROFILES.find(p => p.match.test(EMBED_MODEL)) ?? { prompts: false };
const QUERY_PREFIX = 'task: search result | query: ';

// The id stored in embeddings.model, which find_similar filters on. It names the
// vector SPACE, not just the weights: the same model with and without prompt
// prefixes produces vectors that don't compare, so prompted vectors carry a
// convention suffix. Changing the convention later means bumping it, and the
// backlog then sees every old vector as stale (it keys on this id).
const VECTOR_SPACE = PROFILE.prompts ? `${EMBED_MODEL}#prompts-v1` : EMBED_MODEL;

// Max input chars per embed. Raised 2000→6000 with the emb-gemma switch — sits inside
// emb-gemma's clean ~8k-char (2048-tok) window, capturing long-memory body content that
// the old 2000 cap truncated away. Centralized here so all callers stay consistent.
export const EMBED_MAX_CHARS = Number(process.env.EMBED_MAX_CHARS) || 6000;

// Model used by the "local" provider (@huggingface/transformers, no service required).
const LOCAL_MODEL = 'all-MiniLM-L6-v2';

// The embedding provider is a SETUP-TIME choice (EMBED_PROVIDER env, or
// ~/.memorycentralrc.json → "embedProvider": "ollama" | "local") — never a silent
// runtime fallback. Vectors from different models live in different spaces, so a
// mid-operation provider swap poisons the table with rows invisible to find_similar
// (6 MiniLM vectors were stranded exactly that way when per-row Ollama errors
// triggered the old fallback; found 2026-07-10). When the provider fails, embed()
// returns null and callers leave the memory pending; backlog.js backfills once
// the provider works again.
export const EMBED_PROVIDER = resolveProvider();

function resolveProvider() {
  const valid = v => v === 'ollama' || v === 'local';
  if (valid(process.env.EMBED_PROVIDER)) return process.env.EMBED_PROVIDER;
  try {
    const rc = JSON.parse(readFileSync(join(homedir(), '.memorycentralrc.json'), 'utf8'));
    if (valid(rc.embedProvider)) return rc.embedProvider;
  } catch {}
  return 'ollama';
}

// The model every stored vector must match under the active provider. The
// pending-embedding backlog is defined against this (see backlog.js).
export function activeModel() {
  return EMBED_PROVIDER === 'local' ? LOCAL_MODEL : VECTOR_SPACE;
}

// Frames text the way the active model expects. `query` is a search string;
// `document` is a chunk body plus its memory's title. Without a kind the text
// passes through untouched (provider probes). The plain document form is
// chunk.js's own, so a model without prompts embeds exactly what it always did.
function frame(text, { kind, title } = {}) {
  const prompts = EMBED_PROVIDER !== 'local' && PROFILE.prompts;
  if (kind === 'query') return prompts ? QUERY_PREFIX + text : text;
  if (kind === 'document') return prompts ? `title: ${title || 'none'} | text: ${text}` : chunkText(title, text);
  return text;
}

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
async function ollamaEmbed(text) {
  let res;
  try {
    res = await fetch(`${OLLAMA_BASE}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EMBED_MODEL, input: text, truncate: true, keep_alive: EMBED_KEEP_ALIVE,
        ...(PROFILE.options && { options: PROFILE.options }),
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
        `no response in ${EMBED_TIMEOUT_MS}ms — ${EMBED_MODEL} may be cold-loading behind a larger model (raise EMBED_TIMEOUT_MS)`);
    }
    // The useful detail lives on err.cause (ECONNREFUSED, ENOTFOUND, a TLS
    // failure); err.message is a uniformly useless "fetch failed".
    const detail = err?.cause?.code || err?.cause?.message || err?.message || 'unknown';
    throw new EmbedError('provider_down', `cannot reach Ollama at ${OLLAMA_BASE} (${detail})`);
  }

  if (!res.ok) {
    // A pulled-out model 404s here. That exact failure killed two pins of the
    // old extraction model silently (llama3.1, gemma4:latest) and was read both
    // times as "Ollama isn't running" — name the tag and the fix instead.
    if (res.status === 404) {
      throw new EmbedError('model_missing', `${EMBED_MODEL} is not installed — ollama pull ${EMBED_MODEL}`);
    }
    const body = await res.text().then(t => t.slice(0, 200).trim()).catch(() => '');
    throw new EmbedError('http_error', `Ollama returned HTTP ${res.status} for ${EMBED_MODEL}${body ? ` — ${body}` : ''}`);
  }

  const { embeddings } = await res.json().catch(() => ({}));
  if (!embeddings?.[0]?.length) {
    throw new EmbedError('bad_response', `Ollama returned no vector for ${EMBED_MODEL}`);
  }
  return { vector: embeddings[0], model: VECTOR_SPACE };
}

// ── Provider "local": @huggingface/transformers (no service required) ───────

let _pipe = null;

async function localEmbed(text) {
  if (!_pipe) {
    try {
      const { pipeline } = await import('@huggingface/transformers');
      process.stderr.write('  Loading local embedding model (first run downloads ~25 MB)...\n');
      _pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
    } catch (err) {
      // Usually a failed first-run download, which no amount of retrying fixes
      // and which has nothing to do with a provider being "down".
      throw new EmbedError('local_load_failed', `could not load ${LOCAL_MODEL}: ${err?.message || err}`);
    }
  }
  const out = await _pipe(text, { pooling: 'mean', normalize: true });
  return { vector: Array.from(out.data), model: LOCAL_MODEL };
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
//   local_load_failed transformers.js could not load the model
//   unexpected        anything not anticipated here — still reported, never eaten
//
// `opts.kind` is 'query' (find_similar) or 'document' (a chunk body, with
// `opts.title`) — see frame(). Queries and documents must be framed by the same
// convention or they land in different spaces, so every caller states which it is.
export async function embed(text, opts) {
  const input = frame(String(text), opts).slice(0, EMBED_MAX_CHARS);
  try {
    const { vector, model } = EMBED_PROVIDER === 'local' ? await localEmbed(input) : await ollamaEmbed(input);
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
