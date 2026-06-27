# Consumer Manifest — MemoryCentral's side of the BenchLLAMA contract

**Status:** Built 2026-06-15 (MemoryCentral side). BenchLLAMA drop-report consumer still pending.
**Mirrors:** `OllamaMCP/planning/consumer-manifest.md` (the shared contract + OllamaMCP impl).

---

## Purpose — close the loop with BenchLLAMA

Data flows two ways between BenchLLAMA (producer) and its consumers:

- **producer → consumer:** `rankings.json` — "what's good" (BenchLLAMA tells consumers which models score well).
- **consumer → producer:** *this manifest* — "what I actually use, and **how I chose it**."

With both directions, BenchLLAMA can make a **usage-aware drop recommendation** (reclaim disk
from Ollama models nobody uses) instead of guessing from rankings alone, and it can see **policy
divergence** across consumers — which is the entire point of the return channel.

## Why MemoryCentral's policy is NOT "top-ranked"

OllamaMCP's spec assumed `MemoryCentral = top-ranked`. That is **inaccurate**, and correcting it is
the motivating example for this whole feedback channel:

1. MemoryCentral originally *did* pick by raw ranking — granite-embedding:30m won BenchLLAMA's EMB battery.
2. In production it was **unfit**: its 512-token window truncated **66% of the corpus** (our memories
   are long documents). Top of the leaderboard, unusable in practice.
3. We then **helped tune the EMB battery** to weight a real requirement — clean long-context
   retrieval (~8k chars). Under the tuned battery, `embeddinggemma:300m` wins.

So the honest policy is **`requirements-fit`**: take the EMB #1, but only on a battery that encodes
a hard requirement. **Rank ≠ fitness** — and the manifest is how BenchLLAMA learns that, so it can
keep tuning its batteries to reflect how consumers really use the results. (The same pattern is
playing out for OllamaMCP, whose top-ranked model isn't the most efficient for its tools — hence its
`efficiency-balanced` policy.)

Full embedding rationale: [`embedding-eval-2026-06-13.md`](./embedding-eval-2026-06-13.md).

---

## Manifest schema (shared, **schema 2**)

**Path:** `~/.config/ollama-consumers/memoryCentral.json`. The directory is the shared
model-selection bus (its own `README.md`, maintained by BenchLLAMA, is the authoritative spec).
Ownership is strict: BenchLLAMA writes `benchllama-rankings.json` (producer→consumers); each
consumer writes only its own `<consumer>.json` (consumer→producer). Schema 2 is additive over v1
(bare-string assignments still parse); we adopted it 2026-06-15.

```json
{
  "schema": 2,
  "consumer": "memoryCentral",
  "generated": "2026-06-15T07:36:07Z",
  "selection_policy": "requirements-fit",
  "source": "benchllama@2026-06-15",
  "assignments": {
    "embed":   { "model": "embeddinggemma:300m", "capability": "embedding", "basis": "embedding_long", "tier": "primary" },
    "extract": { "model": "gemma4:latest",       "capability": "manual",    "tier": "primary" }
  },
  "models_in_use": ["embeddinggemma:300m", "gemma4:latest"],
  "gaps": [
    { "capability": "embedding", "observed_with": "granite-embedding:30m",
      "issue": "512-token window truncated 66% of the corpus",
      "wanted": "long-document context-window dimension", "status": "resolved" }
  ],
  "rationale": { "embed": "…", "extract": "…" }
}
```

Field notes:

- **`selection_policy`** — free label for *how* we chose. MemoryCentral = `requirements-fit`.
- **`source`** — the rankings version ingested; auto-derived from `benchllama-rankings.json`'s
  `generated` stamp (self-maintaining for BenchLLAMA's currency check). Flips to `manual` if
  `EMBED_MODEL` is an explicit env override, or if no rankings file is present to ingest.
- **`assignments`** — role → `{ model, capability, basis?, tier? }`. `capability` (from the bus
  vocab: `coding|embedding|vision|ocr|chat|routing|manual`) drives **per-capability** drop logic;
  `basis` names the exact list when a capability has more than one (embedding does → `embedding_long`);
  `tier` is `primary`|`fallback`. `embed` = semantic search + `save_memory`; `extract` = sync-time
  metadata extraction, `capability: manual` (deliberate quality pin → protected, never drop-evaluated).
- **`models_in_use`** — flat protected set. The Tier-2 fallback `all-MiniLM-L6-v2`
  (`@huggingface/transformers`) is **excluded** — not an Ollama model, no Ollama-library disk.
- **`gaps[]`** — structured battery-refinement signal (supersedes free-text for BenchLLAMA's gap
  backlog). `status`: `open`|`resolved`. Ours records the granite truncation → resolved by the
  `embedding_long` tier.
- **`rationale`** — human prose only, not machine-parsed.

---

## Validation against BenchLLAMA's `rankings.json` (2026-06-27)

BenchLLAMA now publishes `~/.config/ollama-consumers/benchllama-rankings.json` (the producer→consumer
"what's good" file). It confirms the feedback loop worked: the embedding battery was **split into
`embedding_short` and `embedding_long`** — the long-context tuning MemoryCentral asked for. Our
`embed` assignment equals `rankings.embedding_long[0]` (verified). The split is decisive (the
`2026-06-27` drop scores two embedding models):

| model | short rank | long rank | composite_long | quality/GB |
|---|---|---|---|---|
| granite-embedding:30m | #1 | #2 | 0.2787 | 8.402 (best) |
| embeddinggemma:300m | #2 | **#1** | 0.8312 | 1.327 |

`top-ranked` (short battery) and `efficiency-balanced` (best quality/GB) would **both** pick
granite — which fails us (`embedding_long` last, 512-tok truncation). Only `requirements-fit` =
`embedding_long[0]` lands on embeddinggemma. That divergence is precisely the signal this manifest
returns to BenchLLAMA. Re-validated against the `benchllama@2026-06-27` drop: ranking order and
our pick are unchanged.

---

## Implementation (`server/manifest.js`)

`buildManifest(generatedISO)` builds the object from a single source of truth — `EMBED_MODEL` and
`EXTRACT_MODEL` exported from `server/embed.js`. `writeManifest()` writes the file and never throws
(best-effort telemetry must not block startup or a re-embed).

**Triggers:**

- **`server/index.js` on boot** — refreshes every session launch (the MCP server starts per
  session). Ollama-independent; wrapped so a write failure can't block the server.
- **`server/reembed.js` on completion** — a re-embed is the moment the active embedding assignment
  changes, so the manifest is rewritten to reflect the new model.

(MemoryCentral has no auto-importer of `rankings.json` — the embed choice is human-applied, informed
by the BenchLLAMA eval. If/when an importer lands, it should also call `writeManifest()`.)

---

## Pending — BenchLLAMA drop-report (producer side)

Globs `~/.config/ollama-consumers/*.json`, unions every `models_in_use` into the working set, then
per installed Ollama model classifies **KEEP / ADVISE-SWITCH / DROP-candidate / UNSCORED**, never
auto-dropping an in-use model. MemoryCentral's manifest contributes `embeddinggemma:300m` and
`gemma4:latest` to the protected set, plus the `requirements-fit` policy + `rationale` that should
inform EMB-battery tuning. Spec lives on the OllamaMCP side.
