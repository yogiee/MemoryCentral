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
      embed: 'requirements-fit: embeddinggemma:300m == rankings.embedding_long[0]. Short-battery ' +
             'and efficiency (quality/GB) winners both = granite-embedding:30m, which fails us.',
      extract: 'gemma4:latest manually pinned for extraction accuracy (rare, not latency-sensitive); ' +
               'replaced the stale, uninstalled llama3.1:latest default on 2026-06-15.',
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
