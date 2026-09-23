import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const OLLAMA_BASE = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '');

// Tier-1 embedding model. Override via EMBED_MODEL.
// embeddinggemma:300m chosen 2026-06-13 over nomic and the BenchLLAMA EMB winner
// granite-embedding:30m (whose 512-token window truncated 66% of our memories).
// emb-gemma: 768-dim (drop-in), clean retrieval to ~8k chars, beats nomic on every
// discrimination metric on our corpus. Full rationale: docs/embedding-eval-2026-06-13.md.
export const EMBED_MODEL = process.env.EMBED_MODEL ?? 'embeddinggemma:300m';

// Ollama model used by extractProjectMeta() to derive project description + stack
// tags during sync. Manual pin (not leaderboard-selected), but constrained by the
// EXTRACT_TIMEOUT_MS budget below — this call sits on the Stop hook, and re-runs
// whenever a project's memory content drifts, so it is NOT the rare event the old
// "accuracy over speed" note assumed. Measured on the real 3000-char payload:
// gemma4:12b 82.1s, gemma4:12b-mlx 30.3s, gemma4:e4b-mlx 24.2s. The #1 worker is
// unusable here regardless of its scores; e4b-mlx is workers #5 with the same
// instruction_adherence (1.0) and clears the budget with room to spare.
// Note the stack tags mostly don't depend on this — a project's `## Stack` block in
// CLAUDE.md wins when present (see refreshProjectMeta), so in practice the model
// supplies the description and little else.
// Pinned 2026-09-23 to granite4.2:3b, replacing gemma4:e4b-mlx for residency: e4b
// holds ~9.4 GB whatever its settings (MLX, weights-bound), enough to evict other
// models at session end. granite4.2:3b is 2.6 GB — but ONLY with EXTRACT_NUM_CTX
// and EXTRACT_THINK below. Without them it pre-allocates 13.3 GB and thinks for
// 24-85s, past the budget. Measured on all 27 projects' real payloads (same call,
// both models): granite 0 failures, 0.9-3.2s (median 1.6s) vs e4b 1.1-5.2s (2.4s);
// descriptions comparable. It dumped the whole tag allowlist once (see
// MAX_STACK_TAGS). e4b's tags were slightly better on projects with no `## Stack`.
// History: gemma4:latest (2026-08-23 → uninstalled, 404'd silently) and before it
// llama3.1:latest (2026-06-15, same death). Verify this tag still resolves before
// trusting a sync's extracted metadata.
// Centralized + exported so the consumer manifest (manifest.js) reports one source of truth.
export const EXTRACT_MODEL = process.env.EXTRACT_MODEL ?? 'granite4.2:3b';

// Abort budget for one extraction. Raised 30s → 60s on 2026-08-23: the pinned model
// needs ~24s on a real corpus, and 30s left only 19% headroom — thin enough that a
// busy GPU or a larger memory set silently returned null and looked like a dead pin.
// Keep the pin comfortably inside this; if a candidate needs more, it's the wrong
// model for a hook that runs at session end, not a reason to raise the ceiling.
export const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS ?? 60_000);

// Context window for the extract call. Without it Ollama allocates the model's full
// native window (131k-262k), which pre-sizes a GGUF model's KV cache to 13-32 GB for a
// prompt that is ~1k tokens (3000-char slice + instructions). 4096 leaves ~3x headroom.
// MLX models allocate lazily, so this doesn't shrink gemma4:e4b-mlx (its ~9.4 GB is
// weights) — it's what makes a small GGUF pin viable. BenchLLAMA probe, 2026-09-23.
export const EXTRACT_NUM_CTX = Number(process.env.EXTRACT_NUM_CTX ?? 4096);

// Thinking is off for extraction. Thinking-capable models default to on: e4b spent
// 566-833 tokens (9-15s) reasoning before a ~50-token JSON answer, with no quality
// gain; others (qwen3.5:4b-mlx, granite4.2:3b) think past EXTRACT_TIMEOUT_MS.
// Non-thinking models ignore think:false.
export const EXTRACT_THINK = false;

// Closed vocabulary for project stack tags. Used both to prompt the extractor and to
// post-filter its output — no model reliably respects an in-prompt allowlist, so we
// enforce it here. Keep in sync with find_by_stack expectations.
export const STACK_TAGS = [
  'swift', 'swiftui', 'node', 'typescript', 'python', 'react', 'electron',
  'bash', 'homeassistant', 'go', 'rust', 'wordpress', 'html', 'css',
];

// A stack longer than this is the model reciting the allowlist, not describing a
// project — the allowlist filter can't catch that, since every tag is valid.
// granite4.2:3b returned all 14 for WallP; llama3.2:3b did the same in BenchLLAMA's
// probe. An honest stack tops out around 7 (an Electron app: node, typescript, react,
// electron, html, css, bash); past 9 it spans unrelated ecosystems (swift + go +
// wordpress…). Such a stack is dropped to [] — no tags beats wrong ones. Only
// model-extracted stacks pass through here; a `## Stack` block is never capped.
export const MAX_STACK_TAGS = 9;

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
  return EMBED_PROVIDER === 'local' ? LOCAL_MODEL : EMBED_MODEL;
}

// Abort budget for one embed call. Raised 10s -> 30s on 2026-08-28 after the
// cold-start hypothesis (defect 4 of the backlog-gaps report) was finally
// measured rather than assumed. Worst observed case, repeated: an embed issued
// while gemma4:e4b-mlx (8.5 GB, the EXTRACT_MODEL until 2026-09-23) is cold-loading — which is
// exactly what a sync does, since refreshProjectMeta and the embed pass run in
// the same run — takes 4.4-5.3s against the old 10s budget.
//
//   embedder warm, GPU idle                       50-205ms
//   embedder cold, GPU idle                       ~1.2s
//   embedder resident, big model cold-loading     ~370ms
//   embedder cold,     big model cold-loading     4.4-5.3s   <- the budget case
//
// 1.9x headroom on an idle machine is thin by this project's own standard: the
// same reasoning raised EXTRACT_TIMEOUT_MS off 30s, where 19% headroom let a
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
// would also pin the 8.5 GB extract model in memory. This one is 673 MB — cheap
// to keep, and it is the model on the hot path.
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
      body: JSON.stringify({ model: EMBED_MODEL, input: text, truncate: true, keep_alive: EMBED_KEEP_ALIVE }),
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
    // A pulled-out model 404s here. That exact failure has now killed two
    // EXTRACT_MODEL pins silently (llama3.1, gemma4:latest) and was read both
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
  return { vector: embeddings[0], model: EMBED_MODEL };
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
export async function embed(text) {
  const input = String(text).slice(0, EMBED_MAX_CHARS);
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

// Ollama-only: extract description + stack tags from memory content.
// Returns { description, stack } or null if Ollama unavailable.
export async function extractProjectMeta(content) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You analyze software project memory files and output JSON metadata. Always respond with only valid JSON, no extra text.',
          },
          {
            role: 'user',
            content: `Read these project memory files and extract metadata. Respond with ONLY this JSON:
{"description": "<one sentence about what this project actually does>", "stack": ["<real tech tags>"]}

Valid tech tags: ${STACK_TAGS.join(', ')}

Project memory files:
${content.slice(0, 3000)}`,
          },
        ],
        stream: false,
        think: EXTRACT_THINK,
        options: { temperature: 0, num_ctx: EXTRACT_NUM_CTX },
      }),
    });
    clearTimeout(timeout);
    if (!res.ok) {
      // Name the model and the status. sync.js already warns on a null return, but only as
      // "Ollama down or model missing" — ambiguous enough that two dead pins (llama3.1,
      // then gemma4:latest) were read as "Ollama isn't running" and left alone for months.
      // A 404 naming the tag is the difference between noise and an actionable line.
      process.stderr.write(
        `extractProjectMeta: ${EXTRACT_MODEL} returned HTTP ${res.status}` +
        `${res.status === 404 ? ' — model not installed (ollama pull ' + EXTRACT_MODEL + ')' : ''}\n`
      );
      return null;
    }
    const data = await res.json();
    const text = data?.message?.content || '';
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    const meta = JSON.parse(match[0]);
    // Enforce the closed tag vocabulary — models leak out-of-allowlist tags (e.g.
    // "postgres") and over-tag, so filter to known tags and de-dupe.
    if (Array.isArray(meta.stack)) {
      const allow = new Set(STACK_TAGS);
      meta.stack = [...new Set(meta.stack.map(t => String(t).toLowerCase().trim()))].filter(t => allow.has(t));
      if (meta.stack.length > MAX_STACK_TAGS) meta.stack = [];
    } else {
      meta.stack = [];
    }
    return meta;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}
