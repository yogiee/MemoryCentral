# Embedding Model Evaluation — MemoryCentral

**Date:** 2026-06-13
**Author:** Claude (Opus 4.8) + Yogi
**Status:** ✅ Validated by re-tuned BenchLLAMA (2026-06-13, 8 models). Our A/B result reproduced blind. Production still on `nomic-embed-text` pending go-ahead to switch to **`embeddinggemma:300m`**.
**Scripts:** `server/diag_embed.js` (read-only A/B harness), `server/reembed.js` (migration, unused so far)

---

## TL;DR

- The trigger was BenchLLAMA's 2026-06-13 embedding battery, which crowned **`granite-embedding:30m`** as the new champion and declared `nomic-embed-text` "dethroned."
- **Granite is the wrong tool for MemoryCentral.** Its 512-token context window truncates **66% of our memories** (126/191), drops ~79k characters of content, and forces 126 retry-storms. Its benchmark win came from a 33-document corpus of short docs where the cap never engaged.
- We A/B-tested **all four models BenchLLAMA ranked ≥ nomic**, on our real 191-memory corpus, under production conditions (2000-char input target).
- **`embeddinggemma:300m` (benchmark #4) is the right tool.** It is the only candidate that both **fits** (768-dim, 2048-token window → zero truncation) and **beats nomic on every discrimination metric** (recall@1 90.3%→92.7%, recall@5 97.6%→100%, MRR 0.939→0.962).
- The two highest-ranked benchmark models after granite — `qwen3-embedding:4b` and `:0.6b` — both scored **below nomic** on discrimination on our data, and 4b is ~16× slower.

**Recommendation (pending re-tuned benchmark): switch to `embeddinggemma:300m`, not granite.**

---

## UPDATE — BenchLLAMA re-tune confirms (2026-06-13, 8 models)

Yogi re-tuned BenchLLAMA's embedding battery and re-ran it blind. It **independently reproduced this A/B result** and adopted the re-tuning recommendations from the bottom of this report: the battery is now **length-stratified into two axes** (short-input quality vs long-document fit) with a **head-control validity gate** that flags length-biased models.

Source: `BenchLLAMA/rankings/master.md` · `BenchLLAMA/results/embedding_2026-06-13.{md,json}`

**Long-document fit (the axis that matters for us)** — tail recall@5 of a fact in the last sentence at each token bucket; `clean` = deepest bucket still retained (≥0.7):

| Model | Validity | clean | comp(long) | 512t | 1024t | 2048t | 4096t |
|---|:--:|--:|--:|--:|--:|--:|--:|
| **embeddinggemma:300m** | ✅ | **2048t (~8k char)** | **0.72** | 1.0 | 1.0 | **1.0** | 0.0 |
| bge-m3:567m | ✅ | 2048t | 0.68 | 0.8 | 0.9 | 0.7 | **0.3** |
| **nomic (incumbent)** | ✅ | **512t (~2k char)** | 0.40 | 0.8 | 0.6 | 0.1 | 0.2 |
| granite:30m | ✅ | **0t** | 0.24 | 0.4 | 0.1 | 0.1 | 0.1 |
| qwen3-4b / qwen3-0.6b / both snowflake-arctic | ⚠️ confounded | — | (artifact) | — | — | — | — |

**What this adds beyond our run:**

1. **Verdict reproduced blind.** Granite is #2 on short-input quality but **dead last on long fit** (clean 0t — its head-control fact at char ~250 still retrieves at 0.88, *proving* the tail simply truncates away). embeddinggemma is mid-pack short (#5) but **#1 on long fit**. BenchLLAMA's own words: *"This is exactly MemoryCentral's A/B result, reproduced blind."*
2. **embeddinggemma is now BenchLLAMA's general-purpose default** — *"Supersedes nomic and granite as the default."* 768-dim drop-in, clean to ~8k chars.
3. **Our incumbent nomic is weak on long fit** — clean only to **512t (~2k chars)**, which is exactly our current 2000-char slice. nomic was already at its window limit; we've been leaving long-memory recall on the table. embeddinggemma is clean 4× deeper.
4. **Four new models tested; none beat embeddinggemma for us:**
   - `snowflake-arctic-embed:137m` — #1 *short* composite (0.855) but **confounded** (fails head-control gate; clusters by length). Unreliable for long docs.
   - `snowflake-arctic-embed2:568m` — marketed 8192-tok window but **did not deliver** (confounded).
   - `bge-m3:567m` — the **only** model with real retention at 4096t/~16k chars (0.3), most graceful decline — the pick *if* we ever need >8k-char inputs, but weak short composite (0.717).
   - `qwen3-embedding:4b/0.6b` — confounded on long; also want an instruction-prefixed query format Ollama's `/api/embed` doesn't apply.

**Enhancement unlocked:** because embeddinggemma is clean to ~8k chars (vs nomic's ~2k), switching also lets us **raise the embed input slice** in `sync.js`/`embed.js` from 2000 → ~6000 chars to capture more of the long Inspector-style memories — recall content currently truncated away. Worth doing as part of the same migration. Beyond ~8k chars, BenchLLAMA's guidance is to **chunk** (no single model retrieves buried facts cleanly past that).

**Decision:** the switch to `embeddinggemma:300m` is now corroborated by an independent, blind, re-tuned benchmark. Recommend proceeding.

### v2 refinement pass (2026-06-13 03:42) — rankings hold

BenchLLAMA re-ran the long-doc tier with **within-bucket scoring** (each query ranks only against same-length docs, removing document length as a confound). Result: **all 8 models now pass the validity gate**, and the two v1 "confounded" verdicts resolved — but **our pick is unchanged and reinforced**:

- **`embeddinggemma:300m` still #1 on long fit, stronger:** comp(long) **0.83** (was 0.72), curve 0.98→1.0→1.0→1.0 through 2048t (~8k chars). Routing verdict unchanged: *"Supersedes nomic and granite as the default."*
- `snowflake-arctic-embed2:568m` rescued (reliable, clean to ~8k) and `qwen3-embedding:4b` shown to have real-but-jagged 16k retention (0.53 @4096t, slowest at 21 emb/s) — both legitimate long options now, but **neither beats emb-gemma**, and both are irrelevant at our 2k–6k input range.
- granite still clean only to 256t (~1k chars); nomic still clean only to 512t (~2k) — confirming our incumbent is at its window limit.
- **~8k chars (2048t) is the reliable ceiling for the whole field.** No model cleanly holds 16k. Reinforces the plan: raise our slice to ~6k (safe), chunk only if we ever go past ~8k.

Net: the refinement added transparency, not a different answer. `embeddinggemma:300m` remains the recommendation. *(Note: v2 validated bge-m3 + both snowflake models, which were not in our original A/B `CANDIDATES`. They don't threaten emb-gemma for our access pattern, so a re-run isn't required — but they can be dropped into `diag_embed.js` if we ever want >8k-char inputs.)*

---

## Why we didn't just take the benchmark winner

Two course corrections drove this evaluation:

1. **"A better tool is useless if it's not the right tool for the job."** A benchmark win on someone else's corpus is a hypothesis, not a decision. It must be validated against our actual data and access pattern.
2. **"Don't tunnel on #1."** Any model that beats nomic *and fits* is an automatic win, even without the headline 3.3× quality/GB. So we evaluated the whole set ranked ≥ nomic, not just the leader.

The first concrete misfit surfaced immediately: `granite-embedding:30m` returns **HTTP 500 on inputs above ~1400 dense characters** (512-token limit). Our memories run up to **27,296 characters** (Inspector's system-pattern notes), and **62% hit the 2000-char embed cap**. The benchmark's composite score never weighted context-window fit because its retrieval corpus was 33 short documents.

---

## Corpus

- **191 memories across 18 projects** (the live MemoryCentral knowledge DB).
- Embed text per memory = `title \n\n content`, matching `sync.js` exactly.
- Length distribution: **median ≥ 2000 chars (capped); 62% hit the 2000-char cap.** Long tail up to 27k chars (Inspector project notes — architecture, ADRs, quick-start references). The useful specifics in those long memories (BugHerd REST workaround, reverse-SSH dev setup, Snowflake JWT auth pattern) live in the **body tail**, past char 1400.

---

## Method

Read-only harness (`server/diag_embed.js`) — **writes nothing to the live DB**. All models embed via Ollama directly, so results are independent of the stored vectors.

**Unified input rule (fairness):** every model targets a **2000-char input** (parity with current production nomic). On a 5xx/empty response, the harness **halves the input and retries** down to a floor. Models that can't accept 2000 chars (granite) self-truncate — and that fit penalty shows up in the truncation and tail-probe numbers rather than being hidden.

**Candidates** (every BenchLLAMA model ranked ≥ nomic, plus the incumbent):

| label | model | bench rank | dim | context |
|---|---|---|---|---|
| nomic | `nomic-embed-text` | 5 (baseline) | 768 | 8k tok |
| granite | `granite-embedding:30m` | 1 | 384 | ~512 tok |
| qwen3-4b | `qwen3-embedding:4b` | 2 | 2560 | 32k tok |
| qwen3-0.6b | `qwen3-embedding:0.6b` | 3 | 1024 | 32k tok |
| emb-gemma | `embeddinggemma:300m` | 4 | 768 | 2048 tok |

**Three probes:**

1. **Health / throughput / truncation** — fails, 500-retries, chars dropped vs the 2000-char target.
2. **Probe 1 — discrimination.** Query = the opening body line of each memory; measure whether the model ranks that memory's own vector at top. recall@1 / recall@5 / MRR over 191 cases. *Tests the core job: can the 384/768/1024/2560-dim space tell our memories apart?*
3. **Probe 2 — truncation cost.** Query = a sentence drawn from **char 1450+** of the body (the zone granite truncates but the others keep). *Tests whether a smaller context window loses information real queries need.*

---

## Results

### Health / truncation

```
model       dim   truncated   500-retries   multi-attempt
nomic       768   0/191       0             0
granite     384   126/191     126           126
qwen3-4b    2560  0/191       0             0
qwen3-0.6b  1024  0/191       0             0
emb-gemma   768   0/191       0             0

granite avg input = 1306 chars; total chars dropped = 78,701
all others avg input = 1719 chars; 0 dropped (they accept the full 2000-char target)
```

### Probe 1 — discrimination (191 cases, large-n, reliable)

```
model       recall@1   recall@5   MRR
emb-gemma   92.7%      100.0%     0.962   ← best
granite     92.7%       98.4%     0.955
nomic       90.3%       97.6%     0.939   ← baseline
qwen3-0.6b  88.7%       96.0%     0.923   ← BELOW nomic
qwen3-4b    86.3%       96.8%     0.906   ← BELOW nomic (and worst)
```

### Probe 2 — truncation cost (query from char 1450+ of body)

```
model       recall@1   recall@5   MRR
nomic       100.0%     100.0%     1.000   keeps the zone (within 2000)
emb-gemma    66.7%     100.0%     0.750   keeps the zone
qwen3-4b     66.7%      66.7%     0.676
granite      33.3%      66.7%     0.533   truncated the zone away
qwen3-0.6b   33.3%      33.3%     0.389   keeps the zone but semantically weak on it
```

---

## Interpretation

- **Granite (#1) — rejected on fit.** Truncates 66% of the corpus, 126 retry-storms, tail-probe craters to 0.533. The 512-token cap is a hard misfit for our long memories. Notably its Probe-1 discrimination is still strong (0.955) because opening-line queries land in the kept zone — but that's exactly the blind spot: it looks fine until a query targets body content past char 1400.
- **qwen3-4b (#2) — rejected.** Scores **below nomic** on discrimination (86.3% recall@1) and is ~16× slower in practice. Highest dim, worst result — bigger ≠ better on our short, dense memories.
- **qwen3-0.6b (#3) — rejected.** Also **below nomic** on discrimination (88.7%) and worst on Probe 2 despite *not* truncating — a genuine semantic weakness on our content, not a window problem.
- **emb-gemma (#4) — winner.** Best discrimination of the whole field (recall@5 **100%**, MRR **0.962**), fits perfectly (768-dim like nomic, 2048-token window covers our 2000-char slices), zero truncation, zero 500s. Strictly dominates nomic on Probe 1 and never regresses.
- **nomic (baseline) — solid floor.** Perfect Probe 2 (it keeps the full 2000-char zone) and respectable discrimination. The only fitting model it loses to is emb-gemma.

The headline finding: **benchmark rank inverted against our job.** The #1 model is the worst fit; the #4 model is the best fit. This is a textbook case of a leaderboard optimizing for a corpus that doesn't resemble the deployment.

---

## Caveats / known limitations of this run

- **Throughput numbers are unreliable in this run.** Absolute emb/s came out far below BenchLLAMA's (nomic measured 24 emb/s here vs 254 benchmarked) because the dashboard/MCP server was running concurrently and Ollama swapped models in/out of VRAM between corpus builds. Treat the *ratios* as directional only (qwen3-4b clearly catastrophic; granite's 16 emb/s is dragged down by its retry-storms). For absolute speed, trust BenchLLAMA's isolated numbers: emb-gemma 142 emb/s — ample for the Stop-hook, which only re-embeds the **1–5 changed memories per session**, not the whole corpus.
- **Probe 2 has small effective-n and the values cluster on thirds (0.33 / 0.67 / 1.0)** — treat it as corroborating evidence for the truncation story, not a precise metric. The hard truncation stats (granite drops 78,701 chars across 126 memories) are the load-bearing evidence; Probe 2 just confirms the direction.
- **Self-retrieval is a proxy.** Queries are derived from each memory's own text, not from independent user phrasing. It measures discrimination and truncation cost fairly *across models* (every model faces the same proxy), but absolute recall would differ with real user queries. A hand-authored known-item query set would strengthen this — deferred.
- Single hardware point (M1 Max 32GB), single run, no warm-up isolation between models.

---

## Recommendations for re-tuning BenchLLAMA's embedding battery

To make the embedding ranking representative of real RAG/recall workloads like MemoryCentral:

1. **Add long documents to the retrieval corpus.** The current 33-doc set is too short to exercise context windows. Include docs in the 2k–30k char range so the 512-token models are forced to truncate — that's where granite's win evaporates.
2. **Gate on context-window fit.** Make "fails / 500s at the production input length" a hard drop criterion, the same way speed and quality floors already are. A model that can't ingest the target input isn't a candidate regardless of composite score.
3. **Measure at the production input length** (e.g., 2000-char / ~512-token slices), not at whatever length saturates the metric. Report chars-dropped and retry counts per model.
4. **Add a tail-probe dimension** — queries whose answers sit past the truncation boundary — to separate "small window" from "genuinely good retrieval."
5. **Report discrimination on a realistic corpus** (self-retrieval recall@1/@5/MRR over a few hundred items), not only STS/triplet on curated pairs. On our data the STS/triplet leaders (qwen3) underperformed nomic on actual recall.
6. **Weight quality-per-GB and emb/s for the deployment**, but only *after* the fit gate — speed is irrelevant if the model can't ingest the input or can't rank the right doc.

If BenchLLAMA adopts these, expect `embeddinggemma:300m` and `nomic-embed-text` to rise and `granite-embedding:30m` to fall for long-document RAG specifically (it likely stays excellent for short-snippet retrieval).

---

## Decision log / next steps

- [x] Diagnostic complete; production untouched (baseline DB still pristine: 194 nomic + 4 all-MiniLM fallback).
- [x] `server/embed.js` refactored to read `EMBED_MODEL` env var (default unchanged: `nomic-embed-text`), so alternatives can be tested without code edits.
- [x] `server/dashboard.js` tier detection made model-agnostic (Tier 2 = the transformers.js `all-MiniLM-L6-v2` fallback; anything else from Ollama = Tier 1).
- [x] **Yogi:** re-tuned BenchLLAMA (v1 + v2 within-bucket); reproduced our finding blind.
- [x] **EXECUTED 2026-06-13 evening.** Flipped `EMBED_MODEL` default → `embeddinggemma:300m`; raised input slice 2000→6000 (centralized as `EMBED_MAX_CHARS` in `embed.js`, removed per-caller `.slice(0,2000)` in sync.js/index.js/reembed.js); re-embedded 193 memories; cleaned 11 orphaned nomic embeddings; updated `app.js` label, README, CLAUDE.md. Table homogeneous (193 emb-gemma). Sanity check passed.
- [ ] **Restart the `memoryCentral` MCP server** so the live tools load the new `embed.js` (until then `find_similar` embeds queries with the old nomic model and matches 0 of the all-emb-gemma rows).
- [x] On any switch: the whole embeddings table must be regenerated (different vector space) — `reembed.js` enforces a homogeneous-model table and refuses to write a mixed one.

### Migration note (when we do switch)

`find_similar` compares a fresh query vector against **all stored vectors of the active model** — it filters `WHERE e.model = ?` (`server/index.js`), where the model string is whatever the query's embedder returns. So there is no dimension-mismatch crash, but the table is effectively **single-model**: any row stored under a different model string is invisible to search under the active model (the four legacy `all-MiniLM` rows are currently unreachable while Ollama is up — re-embedding fixes that). `reembed.js` re-embeds the entire corpus with the active `EMBED_MODEL` and aborts if the provider changes mid-run, keeping the table single-model. Back up `stats/knowledge.db` first **and checkpoint WAL** (`PRAGMA wal_checkpoint(TRUNCATE)`) — a plain `cp` of the `.db` without the `-wal` file produces an inconsistent backup (learned the hard way this session).

---

## Fallback architecture (Tier 2) — findings

Three tiers: **Tier 1** Ollama (`nomic` → `embeddinggemma:300m`, 768-dim), **Tier 2** `@huggingface/transformers` in-Node (`all-MiniLM-L6-v2`, 384-dim), **Tier 3** in-context Claude matching (no embeddings). The model is a **one-time setup choice**: a machine with Ollama runs embeddinggemma; a machine without runs all-MiniLM in Node. Because of the `WHERE e.model=?` filter, each engine owns its own model string and single vector space, so switching engines later = a fresh/blank re-embed (acceptable, by design).

### Option B (unify both tiers on embeddinggemma) — tested, NOT viable as a drop-in

The appealing idea: run embeddinggemma on *both* paths (Ollama GGUF when present, transformers.js ONNX when not) so the spaces are interchangeable and adding/removing Ollama needs no reset. **Empirically tested 2026-06-13 and it failed:**

```
Ollama GGUF embeddinggemma  vs  transformers.js ONNX (onnx-community/embeddinggemma-300m-ONNX, q8, mean-pooled)
mean same-text cross-engine cosine : -0.004  (≈orthogonal — NOT the same space)
cross-engine retrieval recall@1    : 13%     (random chance)
```

This is **not** quantization noise — the two engines produce different spaces. Cause (near-certain): EmbeddingGemma's real embedding = transformer → mean-pool → **learned Dense projection head** → normalize, with **task-specific prompt prefixes** (`task: search result | query: …` / `title: none | text: …`). Ollama applies the full pipeline; the generic transformers.js `feature-extraction` + mean-pool skips the projection head and prompts → a near-orthogonal space. Making Option B work requires exactly reproducing Ollama's EmbeddingGemma pipeline in Node and re-testing to ≥0.95 same-text cross-engine cosine + ~100% cross-engine retrieval. Deferred as a research spike, not part of this switch.

### Dependency principle — when does the Ollama path justify itself?

If a future Node-only path ever reaches **parity** with Ollama (same model, same results, even at a modest perf hit), the question inverts: *why keep two paths at all?* Two engines that do the same thing means the Ollama path is just a dependency earning its keep on performance alone. **Decision rule: the Ollama path must be ≥40% faster (or otherwise materially better) than a parity-capable Node path to remain worth the dependency.** Below that bar, collapse to Node-only and drop Ollama as an embedding dependency. (Today this is moot — the Node path is *not* at parity; all-MiniLM is a different, weaker model. The rule applies only once Option B's parity problem is actually solved.)
