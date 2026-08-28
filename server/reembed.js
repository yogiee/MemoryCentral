#!/usr/bin/env node
// One-off migration: re-embed every memory with the current Tier-1 model.
//
// Run this after changing EMBED_MODEL in embed.js — embeddings from different
// models live in different vector spaces (and often different dimensions), so a
// model swap invalidates the whole table. find_similar compares a fresh query
// vector against all stored vectors, so the table must be homogeneous.
//
//   node server/reembed.js          # re-embed all memories
//   node server/reembed.js --stale  # only rows whose model != current EMBED_MODEL
//
// Idempotent: re-running simply regenerates vectors in place.

import { openDb } from './db.js';
import { embed } from './embed.js';
import { embedMemory } from './backlog.js';
import { writeManifest } from './manifest.js';

const staleOnly = process.argv.includes('--stale');

const db = openDb();

// Probe the active provider/model on one row so we know what we're migrating to.
const probe = await embed('embedding model probe');
if (!probe.ok) {
  process.stderr.write(`Cannot embed (${probe.reason}): ${probe.message}\nAborting — nothing changed.\n`);
  db.close();
  process.exit(1);
}
const targetModel = probe.model;
const targetDim = probe.vector.length;
process.stdout.write(`Target model: ${targetModel} (${targetDim}-dim)\n`);

// One row per memory even though embeddings now holds one row per chunk —
// MIN(model) collapses a memory's chunks and, on the mixed-model table this
// script exists to repair, reports the stale model rather than hiding it.
const rows = db.prepare(`
  SELECT m.id, m.title, m.content, m.embed_hash, p.name AS project_name,
         MIN(e.model) AS current_model
  FROM memories m
  JOIN projects p ON p.id = m.project_id
  LEFT JOIN embeddings e ON e.memory_id = m.id
  GROUP BY m.id
  ORDER BY m.id
`).all();

const targets = staleOnly ? rows.filter(r => r.current_model !== targetModel) : rows;
process.stdout.write(`Re-embedding ${targets.length} of ${rows.length} memories${staleOnly ? ' (stale only)' : ''}...\n`);

let done = 0, failed = 0, chunks = 0;
for (const r of targets) {
  const result = await embedMemory(db, r); // chunks long memories, all-or-nothing
  if (!result.ok) {
    failed++;
    if (failed === 1) process.stderr.write(`  first failure (${result.reason}): ${result.message}\n`);
    continue;
  }
  if (result.model !== targetModel) {
    // Provider changed mid-run (e.g. Ollama dropped to the transformers fallback).
    // Stop rather than write a mixed-model table.
    process.stderr.write(`\nProvider changed mid-run (${result.model} != ${targetModel}). Stopping at ${done} to keep the table homogeneous.\n`);
    break;
  }
  done++; chunks += result.chunks;
  if (done % 25 === 0) process.stdout.write(`  ${done}/${targets.length}\n`);
}

// Report any remaining model heterogeneity so the operator knows the state.
const breakdown = db.prepare('SELECT model, COUNT(DISTINCT memory_id) AS n FROM embeddings GROUP BY model ORDER BY n DESC').all();
db.close();

// A re-embed is the moment the active embedding assignment changes — refresh the
// consumer manifest so BenchLLAMA sees the new model in our working set.
const manifestPath = writeManifest();
if (manifestPath) process.stdout.write(`Consumer manifest updated: ${manifestPath}\n`);

process.stdout.write(`\nDone: ${done} memorie(s) re-embedded as ${chunks} chunk(s), ${failed} failed.\n`);
process.stdout.write('Embeddings table now:\n');
for (const b of breakdown) process.stdout.write(`  ${b.model}: ${b.n}\n`);
if (breakdown.length > 1) {
  process.stdout.write('\n⚠  Table is still mixed-model. Re-run once the provider is stable for a homogeneous vector space.\n');
}
