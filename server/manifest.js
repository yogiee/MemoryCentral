// Consumer manifest — MemoryCentral's side of the shared contract with BenchLLAMA.
//
// Data flows two ways via ~/.config/ollama-consumers/ (the shared model-selection bus;
// see its README.md):
//   producer → consumer : benchllama-rankings.json ("what's good", BenchLLAMA-owned)
//   consumer → producer : THIS manifest, memoryCentral.json ("what I use + how I chose")
//
// BenchLLAMA reads manifests as intelligence (usage-aware drop reports + battery gap
// backlog) — never to reshape the rankings. Pure config + filesystem, independent of
// Ollama being up. Best-effort: a write failure must never block the MCP server or a
// re-embed. Schema 2 (objects + gaps[]) per the bus README.

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { EMBED_MODEL, EXTRACT_MODEL } from './embed.js';

const CONSUMER      = 'memoryCentral';
const MANIFEST_DIR  = join(homedir(), '.config', 'ollama-consumers');
const MANIFEST_PATH = join(MANIFEST_DIR, `${CONSUMER}.json`);
const RANKINGS_PATH = join(MANIFEST_DIR, 'benchllama-rankings.json');

// selection_policy is a free label for HOW we chose. MemoryCentral is "requirements-fit":
// take the embedding_long #1, NOT the short-battery or efficiency winner. Raw short-rank +
// best quality/GB both pointed at granite-embedding:30m, whose 512-tok window truncated 66%
// of the corpus (long-rank #7). The structured story lives in gaps[] below.
const SELECTION_POLICY = 'requirements-fit';

// source = which rankings version we ingested (drives BenchLLAMA's currency check). Read it
// from the rankings file's `generated` stamp so it's self-maintaining. "manual" if the embed
// model is an explicit env pin, or if no rankings file is present to ingest.
function resolveSource() {
  if (process.env.EMBED_MODEL) return 'manual';
  try {
    const { generated } = JSON.parse(readFileSync(RANKINGS_PATH, 'utf8'));
    return `benchllama@${String(generated).slice(0, 10)}`; // YYYY-MM-DD
  } catch {
    return 'manual';
  }
}

export function buildManifest(generatedISO) {
  // assignments: role → { model, capability, basis?, tier? }. capability drives per-capability
  // drop logic; basis names the exact list when a capability has more than one (embedding does).
  const assignments = {
    // semantic search (find_similar) + save_memory embeddings.
    embed: {
      model: EMBED_MODEL,
      capability: 'embedding',
      basis: 'embedding_long',
      tier: 'primary',
    },
    // sync-time project description + stack-tag JSON extraction. capability "manual": a
    // deliberate quality pin, not leaderboard-selected → protected, never drop-evaluated.
    extract: {
      model: EXTRACT_MODEL,
      capability: 'manual',
      tier: 'primary',
    },
  };

  return {
    schema: 2,
    consumer: CONSUMER,
    generated: generatedISO,
    selection_policy: SELECTION_POLICY,
    source: resolveSource(),
    assignments,
    // Flat protected set = every model relied on. The Tier-2 fallback all-MiniLM-L6-v2
    // (@huggingface/transformers) is excluded — not an Ollama model, no Ollama-library disk.
    models_in_use: [...new Set(Object.values(assignments).map(a => a.model))].sort(),
    // Structured battery-refinement signal (the gap backlog BenchLLAMA mines). status: open|resolved.
    gaps: [
      {
        capability: 'embedding',
        observed_with: 'granite-embedding:30m',
        issue: '512-token window truncated 66% of the corpus',
        wanted: 'long-document context-window dimension',
        status: 'resolved', // embedding_long tier now exists in the rankings
      },
    ],
    // Human prose only — not machine-parsed (gaps[] supersedes it for the backlog).
    rationale: {
      embed: 'requirements-fit, platform-dependent. Apple Silicon: embeddinggemma-2:270m-bf16-text ' +
             'with prompt prefixes + num_ctx 8192, chosen 2026-10-09 on our own chunk-faithful A/B ' +
             '(docs/embedding-eval-2026-10-09.md): topic/gist tie with v1, +0.06-0.08 MRR on specific ' +
             'facts, settles at 0.73 GB vs v1 holding 2.37 GB. bf16 over the nvfp4 default tag: quality ' +
             'tie, nvfp4 18% slower on M1 and peaks 0.4 GB higher. Elsewhere (all v2 tags are MLX): ' +
             'embeddinggemma:300m. granite-embedding:30m fails us (512-tok window).',
      extract: 'granite4.2:3b pinned 2026-09-23 for residency: 2.6 GB vs gemma4:e4b-mlx 9.4 GB ' +
               '(MLX, weights-bound — no call setting shrinks it). Requires num_ctx 4096 + ' +
               'think:false, both sent; without them granite is 13.3 GB and thinks past the 60s ' +
               'Stop-hook budget. Real payloads, all 27 projects: 0 failures, median 1.6s (e4b ' +
               '2.4s), descriptions comparable. Prior pins: e4b-mlx (2026-08-23), gemma4:latest ' +
               'and llama3.1:latest (both died by silent 404 after uninstall).',
    },
  };
}

// Writes the manifest. Returns the path on success, null on failure (never throws).
export function writeManifest() {
  try {
    mkdirSync(MANIFEST_DIR, { recursive: true });
    writeFileSync(MANIFEST_PATH, JSON.stringify(buildManifest(new Date().toISOString()), null, 2) + '\n');
    return MANIFEST_PATH;
  } catch (err) {
    process.stderr.write(`manifest: skipped (${err.message})\n`);
    return null;
  }
}
