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
// tags during sync. Manual quality pin (not leaderboard-selected): extraction runs
// only for description-less projects, so accuracy matters more than speed. gemma4:latest
// gave the cleanest, allowlist-respecting tags in testing (2026-06-15) — replacing the
// stale llama3.1:latest default, which had been uninstalled and 404'd silently.
// Centralized + exported so the consumer manifest (manifest.js) reports one source of truth.
export const EXTRACT_MODEL = process.env.EXTRACT_MODEL ?? 'gemma4:latest';

// Closed vocabulary for project stack tags. Used both to prompt the extractor and to
// post-filter its output — no model reliably respects an in-prompt allowlist, so we
// enforce it here. Keep in sync with find_by_stack expectations.
export const STACK_TAGS = [
  'swift', 'swiftui', 'node', 'typescript', 'python', 'react', 'electron',
  'bash', 'homeassistant', 'go', 'rust', 'wordpress', 'html', 'css',
];

// Max input chars per embed. Raised 2000→6000 with the emb-gemma switch — sits inside
// emb-gemma's clean ~8k-char (2048-tok) window, capturing long-memory body content that
// the old 2000 cap truncated away. Centralized here so all callers stay consistent.
const EMBED_MAX_CHARS = Number(process.env.EMBED_MAX_CHARS) || 6000;

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

// ── Tier 1: Ollama ──────────────────────────────────────────────────────────

// Uses the modern /api/embed endpoint with truncate:true — the legacy
// /api/embeddings endpoint ERRORS ("input length exceeds the context length")
// on token-dense content instead of truncating, which is exactly how 5 memories
// ended up silently embedded by the old MiniLM fallback (found 2026-07-10):
// 6000 chars of code/URLs can exceed emb-gemma's 2048-token window even though
// typical prose fits. /api/embed truncates to the context window server-side.
async function ollamaEmbed(text) {
  const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text, truncate: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Ollama embed: ${res.status}`);
  const { embeddings } = await res.json();
  return { vector: embeddings[0], model: EMBED_MODEL };
}

// ── Provider "local": @huggingface/transformers (no service required) ───────

let _pipe = null;

async function localEmbed(text) {
  if (!_pipe) {
    const { pipeline } = await import('@huggingface/transformers');
    process.stderr.write('  Loading local embedding model (first run downloads ~25 MB)...\n');
    _pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
  }
  const out = await _pipe(text, { pooling: 'mean', normalize: true });
  return { vector: Array.from(out.data), model: LOCAL_MODEL };
}

// ── Public API ───────────────────────────────────────────────────────────────

// Returns { vector: number[], model: string } or null (configured provider down).
// Callers must handle null gracefully — the memory stays pending, never embedded
// with a different model.
export async function embed(text) {
  const input = String(text).slice(0, EMBED_MAX_CHARS);
  try {
    return EMBED_PROVIDER === 'local' ? await localEmbed(input) : await ollamaEmbed(input);
  } catch {
    return null;
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
  const timeout = setTimeout(() => controller.abort(), 30_000);
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
        options: { temperature: 0 },
      }),
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
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
    } else {
      meta.stack = [];
    }
    return meta;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}
