#!/usr/bin/env node
// READ-ONLY diagnostic: which embedding model is the right tool for MemoryCentral's
// recall job? Tests every BenchLLAMA model ranked >= nomic, vs the incumbent
// nomic-embed-text, on OUR actual corpus. Writes NOTHING to the live DB.
//
// Three questions:
//   1. Discrimination — can each model rank the correct memory top? (topic self-retrieval)
//   2. Truncation cost — does a model's context window lose info real queries need?
//      (tail-probe self-retrieval + truncation stats) — this is where granite's
//      512-token cap is expected to bite on our long memories.
//   3. Reliability / throughput — 500s? fast enough for the Stop-hook sync (runs every session)?
//
//   node server/diag_embed.js
//
// All models embed via Ollama directly (independent of the live embeddings table),
// under ONE unified rule: target 2000-char input (parity with current nomic), and on
// a 5xx/empty response, halve and retry. Models that can't take 2000 chars (granite)
// self-truncate — that fit penalty shows up in the truncation + tail-probe numbers.

import { openDb } from './db.js';

const OLLAMA = 'http://localhost:11434/api/embeddings';

// Every model the benchmark ranked at or above nomic, plus the incumbent baseline.
const CANDIDATES = [
  { label: 'nomic',     model: 'nomic-embed-text' },        // baseline / incumbent
  { label: 'granite',   model: 'granite-embedding:30m' },   // bench #1 (but 512-tok)
  { label: 'qwen3-4b',  model: 'qwen3-embedding:4b' },      // bench #2 (slow, 2560-dim)
  { label: 'qwen3-0.6b',model: 'qwen3-embedding:0.6b' },    // bench #3 (32k ctx)
  { label: 'emb-gemma', model: 'embeddinggemma:300m' },     // bench #4 (768-dim drop-in)
];

const TARGET_CHARS = 2000; // parity with current production nomic slice

// Unified embed: target 2000 chars, halve-and-retry on 5xx/empty down to a floor.
async function embedWith(model, text) {
  let chars = Math.min(text.length, TARGET_CHARS);
  let attempts = 0, had500 = false;
  while (chars >= 150) {
    attempts++;
    const res = await fetch(OLLAMA, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text.slice(0, chars) }),
    });
    if (res.ok) {
      const { embedding } = await res.json();
      if (embedding && embedding.length) return { vector: embedding, chars, attempts, had500 };
    } else if (res.status >= 500) { had500 = true; }
    chars = Math.floor(chars * 0.7);
  }
  return null;
}

function cosine(a, b) {
  let d = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; ma += a[i]*a[i]; mb += b[i]*b[i]; }
  return d / (Math.sqrt(ma) * Math.sqrt(mb) || 1);
}

function stripFrontmatter(c) {
  const m = c.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? c.slice(m[0].length).trim() : c.trim();
}
// First substantive body line(s) → a natural "topic" query (the gist a user would describe).
function topicQuery(content) {
  const body = stripFrontmatter(content);
  const lines = body.split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim())
    .filter(l => l.length > 25 && !l.startsWith('```') && !/^[|`]/.test(l));
  return lines.slice(0, 2).join(' ').slice(0, 220);
}
// A sentence from the granite-dropped zone (full-content offset 1450–2000): the
// info nomic keeps but granite loses. Returns null if the doc has no such zone.
function tailQuery(content) {
  if (content.length < 1600) return null;
  const zone = content.slice(1450, 2000);
  const sentences = zone.split(/(?<=[.\n])/).map(s => s.replace(/[#>*|`\-]+/g,' ').replace(/\s+/g,' ').trim())
    .filter(s => s.length > 35 && /[a-zA-Z]/.test(s) && (s.match(/ /g)||[]).length >= 5);
  return sentences[0] ? sentences[0].slice(0, 200) : null;
}

// ── load corpus ──────────────────────────────────────────────────────────────
const db = openDb();
const memories = db.prepare(`
  SELECT m.id, p.name AS proj, m.title, m.content
  FROM memories m JOIN projects p ON p.id = m.project_id
  ORDER BY m.id
`).all();
db.close();

const embedText = m => `${m.title}\n\n${m.content}`;

// ── build each candidate's corpus, timed, with truncation stats ──────────────
async function buildCorpus({ label, model }) {
  const t0 = Date.now();
  const vecs = [], trunc = [];
  let fails = 0, with500 = 0, multiAttempt = 0;
  for (const m of memories) {
    const full = embedText(m);
    const r = await embedWith(model, full);
    if (!r) { fails++; vecs.push(null); continue; }
    vecs.push({ id: m.id, vector: r.vector });
    trunc.push({ used: r.chars, dropped: Math.max(0, Math.min(full.length, TARGET_CHARS) - r.chars) });
    if (r.had500) with500++;
    if (r.attempts > 1) multiAttempt++;
  }
  const secs = (Date.now() - t0) / 1000;
  return { label, model, vecs, trunc, fails, with500, multiAttempt, secs, dim: vecs.find(Boolean)?.vector.length };
}

async function runProbe(queryFn, corpora) {
  const cases = memories.map(m => ({ m, q: queryFn(m.content) })).filter(c => c.q);
  const out = {};
  for (const c of corpora) {
    let r1 = 0, r5 = 0, mrr = 0, n = 0;
    for (const { m, q } of cases) {
      const qe = await embedWith(c.model, q);
      if (!qe) continue;
      const ranked = c.vecs.filter(Boolean)
        .map(v => ({ id: v.id, score: cosine(qe.vector, v.vector) }))
        .sort((a, b) => b.score - a.score);
      const pos = ranked.findIndex(x => x.id === m.id);
      if (pos < 0) continue;
      n++;
      if (pos === 0) r1++;
      if (pos < 5) r5++;
      mrr += 1 / (pos + 1);
    }
    out[c.label] = { n, r1: r1/n, r5: r5/n, mrr: mrr/n };
  }
  return { cases: cases.length, out };
}

// ── run ──────────────────────────────────────────────────────────────────────
console.log(`Corpus: ${memories.length} memories across ${new Set(memories.map(m=>m.proj)).size} projects`);
console.log(`Candidates: ${CANDIDATES.map(c=>c.label).join(', ')}\n`);

const corpora = [];
for (const cand of CANDIDATES) {
  process.stderr.write(`  embedding corpus with ${cand.label}...\n`);
  corpora.push(await buildCorpus(cand));
}

const pad = s => String(s).padEnd(11);
console.log('═══ HEALTH / THROUGHPUT ═══');
console.log(pad('model')+'dim   emb/s   fails  500-retry  multi-attempt');
for (const c of corpora)
  console.log(pad(c.label)+String(c.dim).padEnd(6)+(memories.length/c.secs).toFixed(0).padEnd(8)+String(c.fails).padEnd(7)+String(c.with500).padEnd(11)+c.multiAttempt);

console.log('\n═══ TRUNCATION (vs the 2000-char target input) ═══');
console.log(pad('model')+'truncated   avg-input-chars   total-chars-dropped');
for (const c of corpora) {
  const dropped = c.trunc.filter(t => t.dropped > 0).length;
  const total = c.trunc.reduce((s,t)=>s+t.dropped,0);
  const avg = (c.trunc.reduce((s,t)=>s+t.used,0)/c.trunc.length).toFixed(0);
  console.log(pad(c.label)+`${dropped}/${c.trunc.length}`.padEnd(12)+avg.padEnd(18)+total.toLocaleString());
}

console.log('\n═══ PROBE 1: topic self-retrieval (query = opening body line; tests DISCRIMINATION) ═══');
const p1 = await runProbe(topicQuery, corpora);
console.log(`cases=${p1.cases}`);
console.log(pad('model')+'recall@1   recall@5   MRR');
for (const c of corpora) { const r = p1.out[c.label];
  console.log(pad(c.label)+`${(r.r1*100).toFixed(1)}%`.padEnd(11)+`${(r.r5*100).toFixed(1)}%`.padEnd(11)+r.mrr.toFixed(3)); }

console.log('\n═══ PROBE 2: tail self-retrieval (query = sentence past char 1450; tests TRUNCATION COST) ═══');
const p2 = await runProbe(tailQuery, corpora);
console.log(`cases=${p2.cases}`);
console.log(pad('model')+'recall@1   recall@5   MRR');
for (const c of corpora) { const r = p2.out[c.label];
  console.log(pad(c.label)+`${(r.r1*100).toFixed(1)}%`.padEnd(11)+`${(r.r5*100).toFixed(1)}%`.padEnd(11)+r.mrr.toFixed(3)); }

console.log('\nDone — no writes to the live DB.');
