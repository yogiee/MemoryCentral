// The embedding models MemoryCentral can run, and which one fits this machine.
//
// One table drives the embedder (embed.js), the onboarding page and every "model
// not installed" hint, so a suggestion can never name a model that can't run here
// — a Windows user was once told to pull an MLX-only model.
//
// Two engines:
//   ollama  a local (or remote) Ollama server. Best quality; needs Ollama.
//   local   in-process ONNX via transformers.js. Nothing to install; CPU only.
//
// Each model carries everything needed to use it correctly: its prompt
// convention, Ollama options, and the chunk size that fits its context window
// (chunk.js). A model fed chunks larger than its window silently embeds only the
// head of each one — the in-Node MiniLM did exactly that until 2026-10-09.

import { cpus } from 'os';
import { CHUNK_CHARS } from './chunk.js';

const GEMMA_QUERY = 'task: search result | query: ';
const gemmaDoc = (title, body) => `title: ${title || 'none'} | text: ${body}`;

export const OLLAMA_MODELS = {
  // Chosen 2026-10-09 on our own A/B (docs/embedding-eval-2026-10-09.md): topic and
  // gist recall tie v1, +0.06-0.08 MRR on specific facts, and it settles at 0.73 GB
  // where v1's llama.cpp runner holds 2.37 GB. MLX-only, so Apple Silicon only.
  'embeddinggemma-2:270m-bf16-text': {
    label: 'EmbeddingGemma 2 (270M, bf16)', sizeMB: 574, mlx: true,
    query: GEMMA_QUERY, doc: gemmaDoc, promptsTag: 'prompts-v1',
    // Without num_ctx Ollama cuts inputs over 8,192 tokens to 2,048 (BenchLLAMA 2026-10-08).
    options: { num_ctx: 8192 },
  },
  // GGUF, runs everywhere Ollama does. Chosen 2026-06-13 over nomic and
  // granite-embedding:30m (docs/embedding-eval-2026-06-13.md). Plain text: prompts
  // were mixed on it, and plain keeps every existing v1 table valid.
  'embeddinggemma:300m': {
    label: 'EmbeddingGemma (300M)', sizeMB: 621, mlx: false,
  },
};

// Other embeddinggemma-2 tags (nvfp4, mxfp8) behave like the bf16 one.
const OLLAMA_FAMILIES = [{ match: /^embeddinggemma-2:/, like: 'embeddinggemma-2:270m-bf16-text' }];

export const LOCAL_MODELS = {
  // Provisional until the Node-tier bake-off lands (docs/embedding-eval-2026-10-09.md).
  'all-MiniLM-L6-v2': {
    label: 'all-MiniLM-L6-v2', sizeMB: 23, hf: 'Xenova/all-MiniLM-L6-v2', dtype: 'fp32',
    pooling: 'mean', maxTokens: 256, chunkChars: 700,
  },
};

export const DEFAULT_LOCAL_MODEL = 'all-MiniLM-L6-v2';
export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

// arch alone misreads an x64 Node running under Rosetta; the CPU name doesn't.
export const APPLE_SILICON = process.platform === 'darwin' &&
  (process.arch === 'arm64' || /Apple/.test(cpus()[0]?.model ?? ''));

export const isLocalHost = host => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(String(host));

// MLX models run only on an Apple Silicon Ollama. For a remote Ollama we can't see
// its platform, so only models that run anywhere are offered.
export function canRunOllamaModel(model, host = DEFAULT_OLLAMA_HOST) {
  const spec = ollamaSpec(model);
  return !spec.mlx || (APPLE_SILICON && isLocalHost(host));
}

export function recommendedOllamaModel(host = DEFAULT_OLLAMA_HOST) {
  return APPLE_SILICON && isLocalHost(host) ? 'embeddinggemma-2:270m-bf16-text' : 'embeddinggemma:300m';
}

// Unknown Ollama models (an EMBED_MODEL override) get plain text, no options, the
// default chunk size.
export function ollamaSpec(model) {
  const like = OLLAMA_MODELS[model] ? model : OLLAMA_FAMILIES.find(f => f.match.test(model))?.like;
  return { label: model, mlx: false, ...(like && OLLAMA_MODELS[like]), id: model };
}

export function localSpec(model) {
  const spec = LOCAL_MODELS[model];
  if (!spec) throw new Error(`unknown built-in model "${model}" (known: ${Object.keys(LOCAL_MODELS).join(', ')})`);
  return { ...spec, id: model };
}

// The id stored with every vector (embeddings.model), which find_similar filters
// on and the backlog keys staleness to. It names the vector SPACE, not just the
// weights: the same model with another prompt convention or chunk size produces
// vectors that don't compare. Anything that changes the space changes this id, and
// every old vector then reads as stale and is re-embedded. The ids of the two
// production spaces as of 2026-10-09 are unchanged by this scheme.
export function vectorSpace(engine, spec) {
  const chunk = spec.chunkChars && spec.chunkChars !== CHUNK_CHARS ? `#c${spec.chunkChars}` : '';
  if (engine === 'local') return `${spec.id}${chunk}`;
  return `${spec.id}${spec.promptsTag ? `#${spec.promptsTag}` : ''}${chunk}`;
}
