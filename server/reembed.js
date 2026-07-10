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
import { writeManifest } from './manifest.js';

const staleOnly = process.argv.includes('--stale');
const now = new Date().toISOString();

const db = openDb();

// Probe the active provider/model on one row so we know what we're migrating to.
const probe = await embed('embedding model probe');
if (!probe) {
  process.stderr.write('No embedding provider available (Ollama down, no fallback). Aborting — nothing changed.\n');
  db.close();
  process.exit(1);
}
const targetModel = probe.model;
const targetDim = probe.vector.length;
process.stdout.write(`Target model: ${targetModel} (${targetDim}-dim)\n`);

const rows = db.prepare(`
  SELECT m.id, m.title, m.content, p.name AS project_name, e.model AS current_model
  FROM memories m
  JOIN projects p ON p.id = m.project_id
  LEFT JOIN embeddings e ON e.memory_id = m.id
  ORDER BY m.id
`).all();

const targets = staleOnly ? rows.filter(r => r.current_model !== targetModel) : rows;
process.stdout.write(`Re-embedding ${targets.length} of ${rows.length} memories${staleOnly ? ' (stale only)' : ''}...\n`);

const upsert = db.prepare(`
  INSERT INTO embeddings (memory_id, vector, model, generated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(memory_id) DO UPDATE SET vector=excluded.vector, model=excluded.model, generated_at=excluded.generated_at
`);

let done = 0, failed = 0;
for (const r of targets) {
  const text = `${r.title}\n\n${r.content}`; // embed() applies EMBED_MAX_CHARS
  const result = await embed(text);
  if (!result) { failed++; continue; }
  if (result.model !== targetModel) {
    // Provider changed mid-run (e.g. Ollama dropped to the transformers fallback).
    // Stop rather than write a mixed-model table.
    process.stderr.write(`\nProvider changed mid-run (${result.model} != ${targetModel}). Stopping at ${done} to keep the table homogeneous.\n`);
    break;
  }
  upsert.run(r.id, JSON.stringify(result.vector), result.model, now);
  done++;
  if (done % 25 === 0) process.stdout.write(`  ${done}/${targets.length}\n`);
}

// Report any remaining model heterogeneity so the operator knows the state.
const breakdown = db.prepare('SELECT model, COUNT(*) AS n FROM embeddings GROUP BY model ORDER BY n DESC').all();
db.close();

// A re-embed is the moment the active embedding assignment changes — refresh the
// consumer manifest so BenchLLAMA sees the new model in our working set.
const manifestPath = writeManifest();
if (manifestPath) process.stdout.write(`Consumer manifest updated: ${manifestPath}\n`);

process.stdout.write(`\nDone: ${done} re-embedded, ${failed} failed.\n`);
process.stdout.write('Embeddings table now:\n');
for (const b of breakdown) process.stdout.write(`  ${b.model}: ${b.n}\n`);
if (breakdown.length > 1) {
  process.stdout.write('\n⚠  Table is still mixed-model. Re-run once the provider is stable for a homogeneous vector space.\n');
}
