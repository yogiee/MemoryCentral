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
import { chunkMemory } from './chunk.js';

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
};

// Each variant = a model, a prompt convention, and an output width. 256-dim rows are
// Matryoshka truncations of the 768-dim vectors (slice + renormalise), which is what
// Ollama's `dimensions` does; verified against the API once per run below.
const VARIANTS = [
  { id: 'v1',            model: 'v1',      prefix: false, dims: 768 },  // production today
  { id: 'v1+prefix',     model: 'v1',      prefix: true,  dims: 768 },
  { id: 'v2bf16',        model: 'v2bf16',  prefix: false, dims: 768 },
  { id: 'v2bf16+prefix', model: 'v2bf16',  prefix: true,  dims: 768 },
  { id: 'v2nvfp4',       model: 'v2nvfp4', prefix: false, dims: 768 },
  { id: 'v2nvfp4+prefix',model: 'v2nvfp4', prefix: true,  dims: 768 },
  { id: 'v1+prefix@256', model: 'v1',      prefix: true,  dims: 256 },
  { id: 'v2bf16+prefix@256', model: 'v2bf16', prefix: true, dims: 256 },
];
const BASELINE = argVal('--baseline', 'v1');
if (!VARIANTS.some(v => v.id === BASELINE)) throw new Error(`--baseline ${BASELINE}: not a variant`);

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

const norm = v => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map(x => x / s); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const cut = (v, d) => (d >= v.length ? v : norm(v.slice(0, d)));

// ── Corpus ───────────────────────────────────────────────────────────────────

const db = openDb();
const memories = db.prepare(`
  SELECT p.name AS project, m.filename, m.title, m.content
  FROM memories m JOIN projects p ON p.id = m.project_id ORDER BY p.name, m.filename
`).all().map(m => ({ ...m, key: `${m.project}/${m.filename}`, chunks: chunkMemory(m.title, m.content) }));
db.close();
const keyIndex = new Map(memories.map((m, i) => [m.key, i]));
const corpusHash = createHash('sha256').update(memories.map(m => m.key + m.title + m.content).join('\0')).digest('hex').slice(0, 12);
mkdirSync(CACHE, { recursive: true });

// One cached corpus per (model, prefix): chunk vectors at full width plus the per-chunk
// token counts and wall time that the ops comparison needs. Embedded one chunk per
// request, as sync.js does, so throughput is the production number.
async function corpus(modelKey, prefix) {
  const file = join(CACHE, `corpus-${modelKey}-${prefix ? 'prefix' : 'plain'}-${corpusHash}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  process.stderr.write(`  embedding ${memories.reduce((s, m) => s + m.chunks.length, 0)} chunks: ${modelKey}${prefix ? ' +prefix' : ''}\n`);
  const fmt = prefix ? docPrefixed : docPlain;
  const rows = [], errors = [];
  await embedRaw(modelKey, 'warm-up'); // keep the cold load out of the throughput number
  const t0 = Date.now();
  for (let mi = 0; mi < memories.length; mi++) {
    const m = memories[mi];
    for (const c of m.chunks) {
      const r = await embedRaw(modelKey, fmt(m.title, m.content.slice(c.start, c.end)));
      if (r.error) { errors.push({ key: m.key, chunk: c.index, error: r.error }); continue; }
      rows.push({ mi, chunk: c.index, tokens: r.tokens, v: norm(r.vectors[0]) });
    }
  }
  const out = { modelKey, prefix, secs: (Date.now() - t0) / 1000, errors, rows };
  writeFileSync(file, JSON.stringify(out));
  return out;
}

// Query vectors, cached by text so re-scoring after adding judgments is free.
async function queryVectors(modelKey, prefix, texts) {
  const file = join(CACHE, `queries-${modelKey}-${prefix ? 'prefix' : 'plain'}.json`);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const todo = [...new Set(texts)].filter(t => !cache[t]);
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
  const q = cut(qv, dims);
  for (const r of rows) {
    const s = dot(q, dims === 768 ? r.v : r.cut);
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

if (arg('--ops')) { await ops(); process.exit(0); }

console.log(`Corpus ${corpusHash}: ${memories.length} memories → ${memories.reduce((s, m) => s + m.chunks.length, 0)} chunks`);
console.log(`Probes: ${Object.entries(probes).map(([k, v]) => `${k}=${v.length}`).join(' · ')} · real=${real.length} (${Object.keys(judgments).length} judged)\n`);

const corpora = {};
for (const v of VARIANTS) {
  const k = `${v.model}|${v.prefix}`;
  if (!corpora[k]) corpora[k] = await corpus(v.model, v.prefix);
}

// MRL sanity: our slice+renormalise must match the API's own `dimensions`.
{
  const t = docPrefixed(memories[0].title, memories[0].content.slice(0, 800));
  const [full, api] = await Promise.all([embedRaw('v2bf16', t), embedRaw('v2bf16', t, { dimensions: 256 })]);
  console.log(`MRL check (v2bf16, 256d): cosine(ours, api) = ${dot(cut(norm(full.vectors[0]), 256), norm(api.vectors[0])).toFixed(5)}\n`);
}

console.log('═══ HEALTH / THROUGHPUT (one chunk per request, warm) ═══');
console.log('corpus              chunks  errors  max-tok  mean-tok  chunks/s');
for (const c of Object.values(corpora)) {
  const toks = c.rows.map(r => r.tokens);
  console.log(`${c.modelKey}${c.prefix ? '+prefix' : ''}`.padEnd(20) + String(c.rows.length).padEnd(8) + String(c.errors.length).padEnd(8) +
    String(Math.max(...toks)).padEnd(9) + mean(toks).toFixed(0).padEnd(10) + (c.rows.length / c.secs).toFixed(1));
}

const allTexts = [...new Set([...Object.values(probes).flat().map(x => x.q), ...real])];
const results = {}; // variant → probe → per-query RR array
const realRanks = {}; // variant → query → top-10 keys
const top5 = {};      // variant → query → top-5 memory indexes (for --agree)

for (const v of VARIANTS) {
  const c = corpora[`${v.model}|${v.prefix}`];
  if (v.dims !== 768) for (const r of c.rows) r.cut = cut(r.v, v.dims);
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
  console.log(`variant             nDCG@5   P@5(rel≥1)  ΔnDCG vs ${BASELINE} [95% CI]`);
  const nd = Object.fromEntries(VARIANTS.map(v => [v.id, judged.map(q => ndcg5(realRanks[v.id][q].map(k => keyIndex.get(k)), judgments[q]))]));
  for (const v of VARIANTS) {
    const p5 = mean(judged.map(q => realRanks[v.id][q].slice(0, 5).filter(k => (judgments[q][k] ?? 0) >= 1).length / 5));
    const [lo, hi] = pairedCI(nd[v.id], nd[BASELINE]);
    const delta = v.id === BASELINE ? '—' : `${sgn(mean(nd[v.id]) - mean(nd[BASELINE]))} [${sgn(lo)}, ${sgn(hi)}]${lo > 0 ? ' ▲' : hi < 0 ? ' ▼' : ''}`;
    console.log(v.id.padEnd(20) + mean(nd[v.id]).toFixed(3).padEnd(9) + pct(p5).padEnd(12) + delta);
  }
}

console.log('\nDone — no writes to the live DB.');
