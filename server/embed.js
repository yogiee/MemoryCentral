const OLLAMA_BASE = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '');

// ── Tier 1: Ollama ──────────────────────────────────────────────────────────

async function ollamaEmbed(text) {
  const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Ollama embed: ${res.status}`);
  const { embedding } = await res.json();
  return { vector: embedding, model: 'nomic-embed-text' };
}

// ── Tier 2: @huggingface/transformers (local, no service required) ──────────

let _pipe = null;

async function localEmbed(text) {
  if (!_pipe) {
    const { pipeline } = await import('@huggingface/transformers');
    process.stderr.write('  Loading local embedding model (first run downloads ~25 MB)...\n');
    _pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
  }
  const out = await _pipe(text, { pooling: 'mean', normalize: true });
  return { vector: Array.from(out.data), model: 'all-MiniLM-L6-v2' };
}

// ── Public API ───────────────────────────────────────────────────────────────

// Returns { vector: number[], model: string } or null (no provider available).
// Callers must handle null gracefully.
export async function embed(text) {
  try { return await ollamaEmbed(text); } catch {}
  try { return await localEmbed(text); } catch {}
  return null;
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
        model: 'llama3.1:latest',
        messages: [
          {
            role: 'system',
            content: 'You analyze software project memory files and output JSON metadata. Always respond with only valid JSON, no extra text.',
          },
          {
            role: 'user',
            content: `Read these project memory files and extract metadata. Respond with ONLY this JSON:
{"description": "<one sentence about what this project actually does>", "stack": ["<real tech tags>"]}

Valid tech tags: swift, swiftui, node, typescript, python, react, electron, bash, homeassistant, go, rust, wordpress, html, css

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
    return JSON.parse(match[0]);
  } catch {
    clearTimeout(timeout);
    return null;
  }
}
