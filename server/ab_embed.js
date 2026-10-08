#!/usr/bin/env node
// READ-ONLY A/B: should MemoryCentral move from embeddinggemma:300m (v1) to
// embeddinggemma-2:270m (v2), and should either model get its trained prompt
// prefixes? Writes NOTHING to the live DB — vectors are cached under stats/embed-ab/.
//
// Unlike diag_embed.js (2026-06-13), this mirrors production retrieval exactly:
// memories are split by chunk.js, every chunk is embedded, and a memory scores as
// its best chunk — the same max-collapse find_similar does in index.js. BenchLLAMA's
// open question (2026-10-08) was whether v2's weaker single-fact recall inside
// 1–2K-token text shows up on our real chunks; only a chunk-faithful test answers it.
//
//   node server/ab_embed.js                 # embed (cached) + score everything
//   node server/ab_embed.js --pool          # also write the real-query judging pool
//   node server/ab_embed.js --ops           # resident memory + query latency per model
//   node server/ab_embed.js --baseline v2bf16+prefix --agree v2bf16+prefix,v2nvfp4+prefix
//                                           # compare against another variant; vector/rank agreement
//   node server/ab_embed.js --ops --models v2bf16,v2nvfp4 --rounds 3
//                                           # interleaved repeat rounds, median + range
//   node server/ab_embed.js --variants v1,node:minilm,node:gemma
//                                           # score a subset (the baseline is always kept)
//   node server/ab_embed.js --ops-local     # in-Node models: load time, RSS, latency, throughput
//
// Probes (known-item = the source memory is the one right answer):
//   topic   opening body line of every memory (continuity with the 06-13 eval)
//   buried  a verbatim sentence from the last 40% of a memory's LAST chunk — a single
//           fact at the far end of chunk-sized text, BenchLLAMA's worst case on real data
//   authored  paraphrased gist/detail queries written blind to the models (queries.json)
//   real    find_similar descriptions from past sessions, scored nDCG@5 against pooled
//           relevance judgments (real-queries.json + judgments.json)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { openDb } from './db.js';
import { chunkMemory, CHUNK_CHARS } from './chunk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE = join(ROOT, 'stats', 'embed-ab');
const DATA = join(ROOT, 'docs', 'embedding-ab-2026-10-09');
const OLLAMA = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '');
const arg = f => process.argv.includes(f);
const argVal = (f, dflt) => { const i = process.argv.indexOf(f); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };

// The prefixes both generations were trained with (model cards). Production sends
// none; the title slot is real here because every chunk already carries its title.
const QUERY_PREFIX = 'task: search result | query: ';
const docPrefixed = (title, body) => `title: ${title || 'none'} | text: ${body}`;
const docPlain = (title, body) => (title ? `${title}\n\n${body}` : body); // = chunk.js

// v2 cuts input over 8,192 tokens to 2,048 unless num_ctx is sent (BenchLLAMA 10-08),
// so any adoption would send it — test the configuration we would ship.
const MODELS = {
  v1:       { tag: 'embeddinggemma:300m',             options: undefined },
  v2bf16:   { tag: 'embeddinggemma-2:270m-bf16-text', options: { num_ctx: 8192 } },
  v2nvfp4:  { tag: 'embeddinggemma-2:270m',           options: { num_ctx: 8192 } },
  // Same models at smaller chunks: does chunk size, not the model, drive fact recall?
  'v1-c1500':     { tag: 'embeddinggemma:300m',             options: undefined,         chunkChars: 1500 },
  'v2bf16-c1500': { tag: 'embeddinggemma-2:270m-bf16-text', options: { num_ctx: 8192 }, chunkChars: 1500 },

  // In-process candidates for the no-Ollama tier (transformers.js on onnxruntime-node,
  // CPU). Pooling, windows and prompts are each model's own (sentence-transformers
  // configs). chunkChars fits the window at ~3.5 chars/token with room for the title
  // and prompt. `minilm-4k` is today's production behaviour, kept for contrast: the
  // 4,000-char chunks overrun its 256-token window, so ~3/4 of each chunk is dropped.
  'minilm':     { engine: 'local', hf: 'Xenova/all-MiniLM-L6-v2', dtype: 'fp32', pooling: 'mean', maxTokens: 256, chunkChars: 700 },
  'minilm-4k':  { engine: 'local', hf: 'Xenova/all-MiniLM-L6-v2', dtype: 'fp32', pooling: 'mean', maxTokens: 256, chunkChars: 4000 },
  'bge-small':  { engine: 'local', hf: 'Xenova/bge-small-en-v1.5', dtype: 'q8', pooling: 'cls', maxTokens: 512, chunkChars: 1500,
                  query: 'Represent this sentence for searching relevant passages: ' },
  'arctic-xs':  { engine: 'local', hf: 'Snowflake/snowflake-arctic-embed-xs', dtype: 'q8', pooling: 'cls', maxTokens: 512, chunkChars: 1500,
                  query: 'Represent this sentence for searching relevant passages: ' },
  'granite-30m':{ engine: 'local', hf: 'onnx-community/granite-embedding-30m-english-ONNX', dtype: 'q8', pooling: 'cls', maxTokens: 512, chunkChars: 1500 },
  'granite-r2': { engine: 'local', hf: 'onnx-community/granite-embedding-small-english-r2-ONNX', dtype: 'q8', pooling: 'cls', maxTokens: 8192, chunkChars: 4000 },
  'nomic':      { engine: 'local', hf: 'nomic-ai/nomic-embed-text-v1.5', dtype: 'q8', pooling: 'mean', maxTokens: 8192, chunkChars: 4000,
                  query: 'search_query: ', doc: (t, b) => `search_document: ${docPlain(t, b)}` },
  'gemma-q8':   { engine: 'local', hf: 'onnx-community/embeddinggemma-300m-ONNX', dtype: 'q8', head: 'sentence_embedding', maxTokens: 2048, chunkChars: 4000,
                  query: QUERY_PREFIX, doc: docPrefixed },
  'gemma-q4':   { engine: 'local', hf: 'onnx-community/embeddinggemma-300m-ONNX', dtype: 'q4', head: 'sentence_embedding', maxTokens: 2048, chunkChars: 4000,
                  query: QUERY_PREFIX, doc: docPrefixed },
};
const isLocal = key => MODELS[key].engine === 'local';
const LOCAL_KEYS = Object.keys(MODELS).filter(isLocal);

// Each variant = a model, a prompt convention, and an output width. 256-dim rows are
// Matryoshka truncations of the 768-dim vectors (slice + renormalise), which is what
// Ollama's `dimensions` does; verified against the API once per run below.
const ALL_VARIANTS = [
  { id: 'v1',            model: 'v1',      prefix: false },  // GGUF default off Apple Silicon
  { id: 'v1+prefix',     model: 'v1',      prefix: true },
  { id: 'v2bf16',        model: 'v2bf16',  prefix: false },
  { id: 'v2bf16+prefix', model: 'v2bf16',  prefix: true },   // production on Apple Silicon
  { id: 'v2nvfp4',       model: 'v2nvfp4', prefix: false },
  { id: 'v2nvfp4+prefix',model: 'v2nvfp4', prefix: true },
  { id: 'v1+prefix@256', model: 'v1',      prefix: true,  dims: 256 },
  { id: 'v2bf16+prefix@256', model: 'v2bf16', prefix: true, dims: 256 },
  { id: 'v1@1500',             model: 'v1-c1500',     prefix: false },
  { id: 'v2bf16+prefix@1500',  model: 'v2bf16-c1500', prefix: true },
  // Local models always use their own prompt convention (none, query-only, or both).
  ...LOCAL_KEYS.map(k => ({ id: `node:${k}`, model: k, prefix: true })),
];
const BASELINE = argVal('--baseline', 'v1');
if (!ALL_VARIANTS.some(v => v.id === BASELINE)) throw new Error(`--baseline ${BASELINE}: not a variant`);
const wanted = argVal('--variants') ? new Set([BASELINE, ...argVal('--variants').split(',')]) : null;
const VARIANTS = wanted ? ALL_VARIANTS.filter(v => wanted.has(v.id)) : ALL_VARIANTS;

// ── Ollama ───────────────────────────────────────────────────────────────────

async function embedRaw(modelKey, input, { dimensions } = {}) {
  const { tag, options } = MODELS[modelKey];
  // truncate:false so a chunk over the window is an error we count, never a silent cut.
  const body = { model: tag, input, truncate: false, keep_alive: '10m', ...(options && { options }), ...(dimensions && { dimensions }) };
  const res = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) return { error: `HTTP ${res.status} ${(await res.text()).slice(0, 160)}` };
  const j = await res.json();
  return { vectors: j.embeddings, tokens: j.prompt_eval_count, ns: j.total_duration };
}

// ── In-process (transformers.js) ─────────────────────────────────────────────

// Tokenise with an explicit max_length so every model is cut at its trained window
// (tokenizer configs often advertise a larger model_max_length than the model was
// trained on — MiniLM says 512, was trained at 256), then pool the way the model's
// sentence-transformers config says. embeddinggemma's ONNX export carries its own
// pooling + Dense head and returns `sentence_embedding` — skipping that head is
// what made the June 2026 attempt produce near-orthogonal vectors.
const localModels = {};
async function loadLocal(key) {
  if (localModels[key]) return localModels[key];
  const spec = MODELS[key];
  const { AutoTokenizer, AutoModel } = await import('@huggingface/transformers');
  const tokenizer = await AutoTokenizer.from_pretrained(spec.hf);
  const model = await AutoModel.from_pretrained(spec.hf, { dtype: spec.dtype });
  async function run(texts) {
    const inputs = await tokenizer(texts, { padding: true, truncation: true, max_length: spec.maxTokens });
    const out = await model(inputs);
    if (spec.head) return out[spec.head].tolist().map(norm);
    const h = out.last_hidden_state, [B, T, H] = h.dims, data = h.data;
    const mask = inputs.attention_mask.data;
    const vecs = [];
    for (let b = 0; b < B; b++) {
      const v = new Array(H).fill(0);
      if (spec.pooling === 'cls') {
        for (let k = 0; k < H; k++) v[k] = data[(b * T) * H + k];
      } else {
        let n = 0;
        for (let t = 0; t < T; t++) {
          if (!Number(mask[b * T + t])) continue;
          n++;
          for (let k = 0; k < H; k++) v[k] += data[(b * T + t) * H + k];
        }
        for (let k = 0; k < H; k++) v[k] /= n || 1;
      }
      vecs.push(norm(v));
    }
    return vecs;
  }
  const countTokens = t => tokenizer(t).input_ids.dims.at(-1);
  return (localModels[key] = { run, countTokens });
}

const norm = v => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map(x => x / s); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const cut = (v, d) => (d >= v.length ? v : norm(v.slice(0, d)));

// ── Corpus ───────────────────────────────────────────────────────────────────

// The corpus is frozen to a snapshot on first run: memories keep arriving while a
// bake-off runs (every save changes the hash and forces every variant to re-embed),
// and variants are only comparable on identical data. --refresh-corpus re-reads the DB.
const SNAPSHOT = join(CACHE, 'corpus-snapshot.json');
mkdirSync(CACHE, { recursive: true });
let rawMemories;
if (existsSync(SNAPSHOT) && !arg('--refresh-corpus')) {
  rawMemories = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
} else {
  const db = openDb();
  rawMemories = db.prepare(`
    SELECT p.name AS project, m.filename, m.title, m.content
    FROM memories m JOIN projects p ON p.id = m.project_id ORDER BY p.name, m.filename
  `).all();
  db.close();
  writeFileSync(SNAPSHOT, JSON.stringify(rawMemories));
}
const memories = rawMemories.map(m => ({ ...m, key: `${m.project}/${m.filename}`, chunks: chunkMemory(m.title, m.content) }));
// Probes are always built from the default chunking (stable across models); each model
// is indexed with its own chunk size.
const chunksFor = (key, m) => (MODELS[key].chunkChars && MODELS[key].chunkChars !== CHUNK_CHARS
  ? chunkMemory(m.title, m.content, { chunkChars: MODELS[key].chunkChars }) : m.chunks);
const keyIndex = new Map(memories.map((m, i) => [m.key, i]));
const corpusHash = createHash('sha256').update(memories.map(m => m.key + m.title + m.content).join('\0')).digest('hex').slice(0, 12);
mkdirSync(CACHE, { recursive: true });

// One cached corpus per (model, prefix): chunk vectors at full width plus the per-chunk
// token counts and wall time that the ops comparison needs. Embedded one chunk per
// request, as sync.js does, so throughput is the production number.
async function corpus(modelKey, prefix) {
  const file = join(CACHE, `corpus-${modelKey}-${prefix ? 'prefix' : 'plain'}-${corpusHash}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  if (isLocal(modelKey)) return localCorpus(modelKey, file);
  process.stderr.write(`  embedding ${memories.reduce((s, m) => s + chunksFor(modelKey, m).length, 0)} chunks: ${modelKey}${prefix ? ' +prefix' : ''}\n`);
  const fmt = prefix ? docPrefixed : docPlain;
  const rows = [], errors = [];
  await embedRaw(modelKey, 'warm-up'); // keep the cold load out of the throughput number
  const t0 = Date.now();
  for (let mi = 0; mi < memories.length; mi++) {
    const m = memories[mi];
    for (const c of chunksFor(modelKey, m)) {
      const r = await embedRaw(modelKey, fmt(m.title, m.content.slice(c.start, c.end)));
      if (r.error) { errors.push({ key: m.key, chunk: c.index, error: r.error }); continue; }
      rows.push({ mi, chunk: c.index, tokens: r.tokens, v: norm(r.vectors[0]) });
    }
  }
  const out = { modelKey, prefix, secs: (Date.now() - t0) / 1000, errors, rows };
  writeFileSync(file, JSON.stringify(out));
  return out;
}

// Batched (8) for wall-time; --ops-local measures the one-chunk-per-call production rate.
async function localCorpus(key, file) {
  const spec = MODELS[key];
  const fmt = spec.doc ?? docPlain;
  const items = memories.flatMap((m, mi) => chunksFor(key, m).map(c => ({ mi, chunk: c.index, text: fmt(m.title, m.content.slice(c.start, c.end)) })));
  process.stderr.write(`  embedding ${items.length} chunks in-process: ${key} (${spec.hf}, ${spec.dtype})\n`);
  const t0 = Date.now();
  const { run, countTokens } = await loadLocal(key);
  const loadSecs = (Date.now() - t0) / 1000;
  const rows = [];
  const t1 = Date.now();
  for (let i = 0; i < items.length; i += 8) {
    const batch = items.slice(i, i + 8);
    const vecs = await run(batch.map(x => x.text));
    batch.forEach((x, j) => {
      const tokens = countTokens(x.text);
      rows.push({ mi: x.mi, chunk: x.chunk, tokens, truncated: tokens > spec.maxTokens, v: vecs[j] });
    });
    if (i % 400 === 0 && i) process.stderr.write(`    ${i}/${items.length}\n`);
  }
  const out = { modelKey: key, prefix: true, loadSecs, secs: (Date.now() - t1) / 1000, errors: [], rows };
  writeFileSync(file, JSON.stringify(out));
  return out;
}

// Query vectors, cached by text so re-scoring after adding judgments is free.
async function queryVectors(modelKey, prefix, texts) {
  const file = join(CACHE, `queries-${modelKey}-${prefix ? 'prefix' : 'plain'}.json`);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const todo = [...new Set(texts)].filter(t => !cache[t]);
  if (isLocal(modelKey) && todo.length) {
    const { run } = await loadLocal(modelKey);
    const qp = MODELS[modelKey].query ?? '';
    for (let i = 0; i < todo.length; i += 32) {
      const batch = todo.slice(i, i + 32);
      (await run(batch.map(t => qp + t))).forEach((v, j) => { cache[batch[j]] = v; });
    }
    writeFileSync(file, JSON.stringify(cache));
    return cache;
  }
  for (let i = 0; i < todo.length; i += 32) {
    const batch = todo.slice(i, i + 32);
    const r = await embedRaw(modelKey, batch.map(t => (prefix ? QUERY_PREFIX + t : t)));
    if (r.error) throw new Error(`query embed ${modelKey}: ${r.error}`);
    batch.forEach((t, j) => { cache[t] = norm(r.vectors[j]); });
  }
  if (todo.length) writeFileSync(file, JSON.stringify(cache));
  return cache;
}

// find_similar's ranking: every chunk scored, each memory kept at its best chunk.
function rankMemories(qv, rows, dims) {
  const best = new Float64Array(memories.length).fill(-Infinity);
  const q = dims ? cut(qv, dims) : qv;
  for (const r of rows) {
    const s = dot(q, dims ? r.cut : r.v);
    if (s > best[r.mi]) best[r.mi] = s;
  }
  return [...best.keys()].sort((a, b) => best[b] - best[a]);
}

// ── Query sets ───────────────────────────────────────────────────────────────

const stripFm = c => { const m = c.match(/^---\n[\s\S]*?\n---\n?/); return m ? c.slice(m[0].length) : c; };
const clean = s => s.replace(/[#>*|`]+/g, ' ').replace(/\s+/g, ' ').trim();

function topicQuery(m) {
  const lines = stripFm(m.content).split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim())
    .filter(l => l.length > 25 && !l.startsWith('```') && !/^[|`]/.test(l));
  return lines.length ? lines.slice(0, 2).join(' ').slice(0, 220) : null;
}

// Last-40% sentence of the last chunk. Skipped for chunks under 1,500 chars, where
// "buried" would mean nothing.
function buriedQuery(m) {
  const c = m.chunks[m.chunks.length - 1];
  const body = m.content.slice(c.start, c.end);
  if (body.length < 1500) return null;
  const zone = body.slice(Math.floor(body.length * 0.6));
  // slice(1): the zone starts mid-sentence, so its first fragment is a word stump.
  const s = zone.split(/(?<=[.!?])\s+|\n+/).slice(1).map(clean)
    .filter(x => x.length >= 40 && x.split(' ').length >= 6 && /[a-z]{3}/.test(x));
  return s.length ? s[0].slice(0, 220) : null;
}

const loadJson = (f, dflt) => (existsSync(join(DATA, f)) ? JSON.parse(readFileSync(join(DATA, f), 'utf8')) : dflt);
const authored = loadJson('queries.json', []).filter(q => keyIndex.has(q.key));
const real = loadJson('real-queries.json', []);
const judgments = loadJson('judgments.json', {}); // { query: { memoryKey: 0|1|2 } }

const probes = {
  topic:  memories.map((m, i) => ({ q: topicQuery(m), target: i })).filter(x => x.q),
  buried: memories.map((m, i) => ({ q: buriedQuery(m), target: i })).filter(x => x.q),
  'authored:gist':   authored.filter(a => a.kind === 'gist').map(a => ({ q: a.query, target: keyIndex.get(a.key) })),
  'authored:detail': authored.filter(a => a.kind === 'detail').map(a => ({ q: a.query, target: keyIndex.get(a.key) })),
};
// Detail queries whose source is a multi-chunk memory: the fact usually lives past
// chunk 1, so the right chunk has to win on its own.
probes['authored:detail-multichunk'] = probes['authored:detail'].filter(x => memories[x.target].chunks.length > 1);

// ── Scoring ──────────────────────────────────────────────────────────────────

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Paired bootstrap of mean(a) - mean(b) over the same queries: 95% CI.
function pairedCI(a, b, n = 4000) {
  const r = rng(20261009), d = a.map((x, i) => x - b[i]), out = [];
  for (let k = 0; k < n; k++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[Math.floor(r() * d.length)]; out.push(s / d.length); }
  out.sort((x, y) => x - y);
  return [out[Math.floor(n * 0.025)], out[Math.floor(n * 0.975)]];
}
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const pct = x => `${(x * 100).toFixed(1)}%`;
const sgn = x => (x >= 0 ? '+' : '') + x.toFixed(3);

function ndcg5(ranked, rel) {
  const gains = ranked.slice(0, 5).map(i => rel[memories[i].key] ?? 0);
  const dcg = gains.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  const ideal = Object.values(rel).sort((a, b) => b - a).slice(0, 5).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  return ideal ? dcg / ideal : 0;
}

// ── Ops: measured residency + warm single-query latency ──────────────────────

function runnerPids() {
  const serve = new Set(execFileSync('pgrep', ['-f', 'ollama serve']).toString().split(/\s+/).filter(Boolean));
  return execFileSync('ps', ['-axo', 'pid=,ppid=']).toString().trim().split('\n')
    .map(l => l.trim().split(/\s+/)).filter(([, pp]) => serve.has(pp)).map(([p]) => p);
}
// Async so a sampler can run alongside the embed calls it is measuring.
function footprintGB(pid) {
  return new Promise(res => {
    let out = '';
    const c = spawn('footprint', ['-f', 'bytes', '-p', pid]);
    c.stdout.on('data', d => { out += d; });
    c.on('close', () => {
      const fp = out.match(/phys_footprint: (\d+)/);
      const mapped = out.match(/^\s*\d+ B\s+(\d+) B\s+\d+ B\s+\d+\s+mapped file$/m);
      res(fp ? (Number(fp[1]) + (mapped ? Number(mapped[1]) : 0)) / 1e9 : NaN);
    });
  });
}
async function unload(tag) {
  await fetch(`${OLLAMA}/api/embed`, { method: 'POST', body: JSON.stringify({ model: tag, input: 'x', keep_alive: 0 }) }).catch(() => {});
}

async function ops() {
  // Each round loads every model alone, in a rotated order, so thermal or background drift
  // lands on all of them rather than on whichever model happened to run last.
  const keys = argVal('--models', Object.keys(MODELS).join(',')).split(',');
  const rounds = Number(argVal('--rounds', 1));
  const queries = probes['authored:gist'].concat(probes.topic).slice(0, 100).map(x => QUERY_PREFIX + x.q);
  const chunks = memories.flatMap(m => m.chunks.map(c => docPrefixed(m.title, m.content.slice(c.start, c.end))));
  const sample = chunks.filter((_, i) => i % 7 === 0); // every 7th chunk: the corpus's length mix
  // Residency is NOT one number. Compute buffers grow with input length, and the two
  // runners treat them oppositely (2026-10-09): llama.cpp (v1) keeps its grown buffers —
  // 0.74 GB idle → 2.37 GB for as long as it stays loaded — while MLX (v2) spikes during
  // long inputs and hands the memory back within seconds. A single snapshot after the
  // work lands at a random point of MLX's release and read nvfp4 as 0.81 in one run and
  // 2.05 in another. So: sample continuously for the peak, then read it settled.
  const heavy = [...chunks].sort((a, b) => b.length - a.length).slice(0, 60);
  const runs = Object.fromEntries(keys.map(k => [k, []]));

  for (let r = 0; r < rounds; r++) {
    for (const key of keys.slice(r % keys.length).concat(keys.slice(0, r % keys.length))) {
      for (const t of Object.values(MODELS)) await unload(t.tag);
      await new Promise(res => setTimeout(res, 1500));
      const before = new Set(runnerPids());
      const t0 = Date.now();
      await embedRaw(key, QUERY_PREFIX + 'warm');
      const cold = Date.now() - t0;
      const fresh = runnerPids().filter(p => !before.has(p));
      const gb = () => (fresh.length === 1 ? footprintGB(fresh[0]) : Promise.resolve(NaN));
      const idle = await gb();
      const lat = [];
      for (const q of queries) { const s = process.hrtime.bigint(); await embedRaw(key, q); lat.push(Number(process.hrtime.bigint() - s) / 1e6); }
      lat.sort((a, b) => a - b);
      let t = Date.now();
      for (let i = 0; i < queries.length; i += 32) await embedRaw(key, queries.slice(i, i + 32));
      const batchQps = queries.length / ((Date.now() - t) / 1000);
      t = Date.now();
      let toks = 0;
      for (const c of sample) toks += (await embedRaw(key, c)).tokens ?? 0;
      const secs = (Date.now() - t) / 1000;
      let peak = idle, sampling = true;
      const sampler = (async () => { while (sampling) { const g = await gb(); if (g > peak) peak = g; } })();
      for (const c of heavy) await embedRaw(key, c);
      sampling = false;
      await sampler;
      await new Promise(res => setTimeout(res, 3000));
      runs[key].push({ idle, peak, settled: await gb(), p50: lat[lat.length >> 1], p95: lat[Math.floor(lat.length * 0.95)],
        batchQps, chunkPs: sample.length / secs, tokPs: toks / secs, cold });
      await unload(MODELS[key].tag);
      process.stderr.write(`  round ${r + 1}/${rounds}: ${key} done\n`);
    }
  }

  const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
  const cell = (rs, f, d = 0, u = '') => {
    const v = rs.map(f);
    return (rounds > 1 ? `${med(v).toFixed(d)}${u} (${Math.min(...v).toFixed(d)}–${Math.max(...v).toFixed(d)})` : `${v[0].toFixed(d)}${u}`).padEnd(rounds > 1 ? 21 : 10);
  };
  console.log(`═══ OPS: ${rounds} round(s), median (min–max); residency = phys_footprint + mapped file ═══`);
  console.log(['model', 'GB idle', 'GB peak', 'GB settled', 'query p50', 'query p95', 'batch q/s', 'chunks/s', 'tok/s', 'cold load']
    .map((h, i) => h.padEnd(i ? (rounds > 1 ? 21 : 10) : 10)).join(''));
  for (const k of keys) {
    const rs = runs[k];
    console.log(k.padEnd(10) + cell(rs, x => x.idle, 2) + cell(rs, x => x.peak, 2) + cell(rs, x => x.settled, 2) + cell(rs, x => x.p50, 0, 'ms') +
      cell(rs, x => x.p95, 0, 'ms') + cell(rs, x => x.batchQps, 0) + cell(rs, x => x.chunkPs, 1) + cell(rs, x => x.tokPs, 0) + cell(rs, x => x.cold, 0, 'ms'));
  }
  console.log(`\n(${queries.length} single queries · ${sample.length} chunks, mean ${Math.round(sample.reduce((s, c) => s + c.length, 0) / sample.length)} chars)`);
  console.log('Models unloaded; the MCP server reloads v1 on its next embed.');
}

// ── Run ──────────────────────────────────────────────────────────────────────

// In-Node engine, measured the way production runs it: one chunk per call, in a
// fresh process per model, so load time and memory belong to that model alone.
// RSS is the whole Node process — the engine lives inside MemoryCentral's server.
async function opsLocalWorker(key) {
  const rssGB = () => process.memoryUsage().rss / 1e9;
  const base = rssGB();
  let t = Date.now();
  const { run } = await loadLocal(key);
  const loadSecs = (Date.now() - t) / 1000;
  const loaded = rssGB();
  const spec = MODELS[key];
  const fmt = spec.doc ?? docPlain;
  const chunks = memories.flatMap(m => chunksFor(key, m).map(c => fmt(m.title, m.content.slice(c.start, c.end))));
  const sample = chunks.filter((_, i) => i % Math.ceil(chunks.length / 120) === 0);
  let peak = loaded;
  const sampler = setInterval(() => { peak = Math.max(peak, rssGB()); }, 100);
  t = Date.now();
  for (const c of sample) await run([c]);
  const chunkPs = sample.length / ((Date.now() - t) / 1000);
  const qs = probes['authored:gist'].slice(0, 50).map(x => (spec.query ?? '') + x.q);
  const lat = [];
  for (const q of qs) { const s = process.hrtime.bigint(); await run([q]); lat.push(Number(process.hrtime.bigint() - s) / 1e6); }
  clearInterval(sampler);
  lat.sort((a, b) => a - b);
  await new Promise(r => setTimeout(r, 3000));
  console.log(JSON.stringify({ key, loadSecs, baseGB: base, loadedGB: loaded, peakGB: peak, settledGB: rssGB(),
    chunkPs, fullIndexMin: chunks.length / chunkPs / 60, chunks: chunks.length, p50: lat[lat.length >> 1], p95: lat[Math.floor(lat.length * 0.95)] }));
}

async function opsLocal() {
  const keys = argVal('--models', LOCAL_KEYS.join(',')).split(',');
  const { execFileSync } = await import('child_process');
  console.log('═══ IN-NODE ENGINE (fresh process per model; one chunk per call, as production embeds) ═══');
  console.log('model         load    RSS loaded  RSS peak  settled  chunks/s  full index   query p50/p95');
  for (const key of keys) {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--ops-local-worker', key], { encoding: 'utf8', maxBuffer: 1 << 24 });
    const r = JSON.parse(out.trim().split('\n').pop());
    console.log(key.padEnd(14) + `${r.loadSecs.toFixed(1)}s`.padEnd(8) + `${r.loadedGB.toFixed(2)} GB`.padEnd(12) + `${r.peakGB.toFixed(2)} GB`.padEnd(10) +
      `${r.settledGB.toFixed(2)}`.padEnd(9) + r.chunkPs.toFixed(1).padEnd(10) + `${r.fullIndexMin.toFixed(1)} min (${r.chunks})`.padEnd(13) +
      `${r.p50.toFixed(0)}/${r.p95.toFixed(0)} ms`);
  }
}

if (arg('--ops')) { await ops(); process.exit(0); }
if (argVal('--ops-local-worker')) { await opsLocalWorker(argVal('--ops-local-worker')); process.exit(0); }
if (arg('--ops-local')) { await opsLocal(); process.exit(0); }

console.log(`Corpus ${corpusHash}: ${memories.length} memories → ${memories.reduce((s, m) => s + m.chunks.length, 0)} chunks`);
console.log(`Probes: ${Object.entries(probes).map(([k, v]) => `${k}=${v.length}`).join(' · ')} · real=${real.length} (${Object.keys(judgments).length} judged)\n`);

const corpora = {};
for (const v of VARIANTS) {
  const k = `${v.model}|${v.prefix}`;
  if (!corpora[k]) corpora[k] = await corpus(v.model, v.prefix);
}

// MRL sanity: our slice+renormalise must match the API's own `dimensions`.
if (VARIANTS.some(v => v.dims)) {
  const t = docPrefixed(memories[0].title, memories[0].content.slice(0, 800));
  const [full, api] = await Promise.all([embedRaw('v2bf16', t), embedRaw('v2bf16', t, { dimensions: 256 })]);
  console.log(`MRL check (v2bf16, 256d): cosine(ours, api) = ${dot(cut(norm(full.vectors[0]), 256), norm(api.vectors[0])).toFixed(5)}\n`);
}

console.log('═══ HEALTH / THROUGHPUT (one chunk per request, warm) ═══');
console.log('corpus              chunks  errors  truncated  max-tok  mean-tok  chunks/s');
for (const c of Object.values(corpora)) {
  const toks = c.rows.map(r => r.tokens);
  const trunc = c.rows.filter(r => r.truncated).length;
  console.log(`${c.modelKey}${c.prefix && !isLocal(c.modelKey) ? '+prefix' : ''}`.padEnd(20) + String(c.rows.length).padEnd(8) + String(c.errors.length).padEnd(8) +
    `${trunc} (${pct(trunc / c.rows.length)})`.padEnd(11) + String(Math.max(...toks)).padEnd(9) + mean(toks).toFixed(0).padEnd(10) +
    (c.rows.length / c.secs).toFixed(1) + (isLocal(c.modelKey) ? ' (batched 8)' : ''));
}

const allTexts = [...new Set([...Object.values(probes).flat().map(x => x.q), ...real])];
const results = {}; // variant → probe → per-query RR array
const realRanks = {}; // variant → query → top-10 keys
const top5 = {};      // variant → query → top-5 memory indexes (for --agree)

for (const v of VARIANTS) {
  const c = corpora[`${v.model}|${v.prefix}`];
  if (v.dims) for (const r of c.rows) r.cut = cut(r.v, v.dims);
  const qv = await queryVectors(v.model, v.prefix, allTexts);
  results[v.id] = {};
  for (const [name, items] of Object.entries(probes)) {
    results[v.id][name] = items.map(({ q, target }) => {
      const ranked = rankMemories(qv[q], c.rows, v.dims);
      (top5[v.id] ??= {})[q] = ranked.slice(0, 5);
      return 1 / (ranked.indexOf(target) + 1);
    });
  }
  realRanks[v.id] = Object.fromEntries(real.map(q => [q, rankMemories(qv[q], c.rows, v.dims).slice(0, 10).map(i => memories[i].key)]));
}

for (const name of Object.keys(probes)) {
  if (!probes[name].length) continue;
  console.log(`\n═══ ${name.toUpperCase()} (n=${probes[name].length}) ═══`);
  console.log(`variant             R@1      R@5      MRR     ΔMRR vs ${BASELINE} [95% CI]`);
  const base = results[BASELINE][name];
  for (const v of VARIANTS) {
    const rr = results[v.id][name];
    const [lo, hi] = pairedCI(rr, base);
    const delta = v.id === BASELINE ? '—' : `${sgn(mean(rr) - mean(base))} [${sgn(lo)}, ${sgn(hi)}]${lo > 0 ? ' ▲' : hi < 0 ? ' ▼' : ''}`;
    console.log(v.id.padEnd(20) + pct(mean(rr.map(x => +(x === 1)))).padEnd(9) + pct(mean(rr.map(x => +(x >= 0.2)))).padEnd(9) + mean(rr).toFixed(3).padEnd(8) + delta);
  }
}

if (argVal('--agree')) {
  // How differently do two variants behave, independent of the answer key? Vector cosine on
  // the same chunks (meaningful only within one model family + convention) and rank overlap.
  const [a, b] = argVal('--agree').split(',').map(id => VARIANTS.find(v => v.id === id));
  console.log(`\n═══ AGREEMENT: ${a.id} vs ${b.id} ═══`);
  if (a.prefix === b.prefix) {
    const ra = corpora[`${a.model}|${a.prefix}`].rows, rb = corpora[`${b.model}|${b.prefix}`].rows;
    const cos = ra.map((r, i) => dot(r.v, rb[i].v)).sort((x, y) => x - y);
    console.log(`same-chunk vector cosine: mean ${mean(cos).toFixed(4)} · p5 ${cos[Math.floor(cos.length * 0.05)].toFixed(4)} · min ${cos[0].toFixed(4)}`);
  }
  console.log('probe                         top-1 same   top-5 overlap');
  const qs = Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, v.map(x => x.q)]));
  qs.real = real;
  for (const v of [a, b]) for (const q of real) (top5[v.id] ??= {})[q] = realRanks[v.id][q].slice(0, 5).map(k => keyIndex.get(k));
  for (const [name, list] of Object.entries(qs)) {
    if (!list.length) continue;
    const t1 = mean(list.map(q => +(top5[a.id][q][0] === top5[b.id][q][0])));
    const ov = mean(list.map(q => top5[a.id][q].filter(x => top5[b.id][q].includes(x)).length / 5));
    console.log(name.padEnd(30) + pct(t1).padEnd(13) + pct(ov));
  }
}

if (arg('--pool')) {
  // Union of every variant's top-5 per real query — what the judge labels.
  const pool = real.map(q => ({ query: q, candidates: [...new Set(VARIANTS.flatMap(v => realRanks[v.id][q].slice(0, 5)))] }));
  writeFileSync(join(CACHE, 'pool.json'), JSON.stringify(pool, null, 1));
  console.log(`\nJudging pool → ${join(CACHE, 'pool.json')} (${pool.reduce((s, p) => s + p.candidates.length, 0)} pairs)`);
}

const judged = real.filter(q => judgments[q]);
if (judged.length) {
  console.log(`\n═══ REAL QUERIES (n=${judged.length}, graded 0/1/2, pooled top-5) ═══`);
  // judged@5 = share of the top-5 the judges actually graded. Unjudged hits score 0, so a
  // variant that surfaces memories outside the original pool is under-rated until the
  // pool is re-judged (run --pool, judge the new pairs, merge into judgments.json).
  console.log(`variant             nDCG@5   P@5(rel≥1)  judged@5  ΔnDCG vs ${BASELINE} [95% CI]`);
  const nd = Object.fromEntries(VARIANTS.map(v => [v.id, judged.map(q => ndcg5(realRanks[v.id][q].map(k => keyIndex.get(k)), judgments[q]))]));
  for (const v of VARIANTS) {
    const p5 = mean(judged.map(q => realRanks[v.id][q].slice(0, 5).filter(k => (judgments[q][k] ?? 0) >= 1).length / 5));
    const [lo, hi] = pairedCI(nd[v.id], nd[BASELINE]);
    const delta = v.id === BASELINE ? '—' : `${sgn(mean(nd[v.id]) - mean(nd[BASELINE]))} [${sgn(lo)}, ${sgn(hi)}]${lo > 0 ? ' ▲' : hi < 0 ? ' ▼' : ''}`;
    const cov = mean(judged.map(q => realRanks[v.id][q].slice(0, 5).filter(k => k in judgments[q]).length / 5));
    console.log(v.id.padEnd(20) + mean(nd[v.id]).toFixed(3).padEnd(9) + pct(p5).padEnd(12) + pct(cov).padEnd(10) + delta);
  }
}

console.log('\nDone — no writes to the live DB.');
