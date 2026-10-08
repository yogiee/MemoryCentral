# Embedding A/B — embeddinggemma:300m (v1) vs embeddinggemma-2:270m (v2)

**Date:** 2026-10-09
**Author:** Claude (Opus 5.5) + Yogi
**Status:** ✅ **Adopted 2026-10-09** on Apple Silicon: `embeddinggemma-2:270m-bf16-text` with prompt prefixes. Other platforms keep `embeddinggemma:300m`, because every v2 tag is MLX-only (`DEFAULT_EMBED_MODEL` in `server/embed.js`).
**Trigger:** BenchLLAMA's 2026-10-08 EMB v3 run (`2026-10-08T14-46-14`). It found v2 ~3× lighter and better on STS, but worse than v1 at finding one buried fact in 1–2K-token text, which is where our chunks live. Its handoff is the `reference_benchllama_embeddinggemma2_findings_2026-10-08.md` memory.
**Harness:** `server/ab_embed.js` (read-only; vectors cached in `stats/embed-ab/`). **Data:** `docs/embedding-ab-2026-10-09/` (`queries.json`, `real-queries.json`, `judgments.json`).

---

## TL;DR

- **BenchLLAMA's concern does not reproduce on our corpus.** On real chunks, v2 is *better* than v1 at single-fact retrieval, not worse. Its buried-fact MRR is +0.035 to +0.045 (CI excludes 0), and paraphrased detail queries gain +0.06 to +0.08 MRR (R@1 36% → 43–46%).
- **Topic and gist retrieval is a dead heat** (MRR 0.935 vs 0.935). Nothing regresses anywhere at 768 dims.
- **On real past `find_similar` queries** (n=34, blind graded), v2 is +0.02 to +0.05 nDCG@5. That's directionally up, but within noise at this n.
- **Memory:** v1 measures **0.75 GB idle but 2.37 GB** once real chunks have gone through it, and it *keeps* that while loaded (BenchLLAMA's 2.3–2.4 GB, confirmed). v2 spikes during long chunks (bf16 2.76 GB, nvfp4 3.16 GB), then **releases back to 0.73 / 0.51 GB within seconds**. So the switch saves **~1.6 GB at rest**, at the cost of a ~0.4–0.8 GB higher transient peak during a sync. *(Corrected 2026-10-09: an earlier single-snapshot reading had v2 bf16 at 0.8–0.9 GB and nvfp4 "ballooning" to 2 GB. Both were artifacts of when the snapshot fell during MLX's release. See [bf16 vs nvfp4](#bf16-vs-nvfp4-head-to-head-2026-10-09).)*
- **bf16 vs nvfp4 is close to a tie.** Quality is identical within noise, and nvfp4's vectors are 0.984 cosine to bf16's. bf16 embeds 21% faster and peaks 0.4 GB lower. nvfp4 sits 0.2 GB lighter at rest and is 196 MB smaller on disk. I lean bf16; see the head-to-head section.
- **Prefixes:** they help v2 on buried and multi-chunk facts. They're mixed on v1 (+ on multi-chunk, slight − on verbatim buried sentences).
- **Don't use 256-dim MRL.** It costs recall on both models (significant on v1).

---

## Method

Everything mirrors production retrieval. Memories are split by `chunk.js` (4,000 chars, 400 overlap), every chunk is embedded one request at a time, and each memory scores as its **best chunk**, the same max-collapse `find_similar` does in `index.js`. Corpus: **678 memories → 1,093 chunks**, 27 projects (hash `ec034818f315`).

`truncate:false` on every call, so an over-window chunk would be a counted error rather than a silent cut. **0 errors in every corpus.** The longest chunk is 1,622 tokens (1,626 with prefix), inside v1's 2,048 window.

### Variants

| id | model | prompt convention | dims |
|---|---|---|---|
| **v1** | `embeddinggemma:300m` | none (= production today: `title\n\nbody`) | 768 |
| v1+prefix | same | doc `title: <title> \| text: <body>`, query `task: search result \| query: <q>` | 768 |
| v2bf16 | `embeddinggemma-2:270m-bf16-text`, `num_ctx: 8192` | none | 768 |
| v2bf16+prefix | same | prefixes | 768 |
| v2nvfp4+prefix | `embeddinggemma-2:270m` (nvfp4), `num_ctx: 8192` | prefixes | 768 |
| …@256 | MRL truncation of the prefixed rows | | 256 |

The 256-dim rows are slice-and-renormalise. Checked against Ollama's own `dimensions: 256`: cosine 1.00000.

### Probes

| probe | n | query | right answer |
|---|---|---|---|
| **topic** | 678 | opening body line(s) of each memory | that memory |
| **buried** | 531 | a verbatim sentence from the last 40% of a memory's *last* chunk (chunks ≥1,500 chars) | that memory |
| **authored: gist** | 200 | paraphrased "what it was about" query | source memory |
| **authored: detail** | 200 | paraphrased query for one fact from the memory's **second half** | source memory |
| ↳ detail-multichunk | 64 | the detail queries whose source spans >1 chunk | source memory |
| **real** | 34 | every distinct `find_similar` description from past Claude sessions | pooled top-5 of all variants, graded 0/1/2 by blind judges |

**Buried** is BenchLLAMA's tail-probe idea on real text instead of filler. **Authored** queries came from 4 subagents that never saw a model output. They had 200 hash-sampled memories over 19 projects and were told to paraphrase (no 4-word runs from the source). A mechanical check found 37/400 (9%) share one 4-gram, mostly stock phrases ("on the home network"). **Real** queries were judged by 6 blind subagents (336 pairs, candidates shuffled, no variant attribution). Every query had ≥1 relevant candidate.

Significance: a paired bootstrap (4,000 resamples) of the per-query difference vs v1. ▲/▼ = the 95% CI excludes 0.

---

## Results

### Retrieval quality (MRR; Δ vs v1 with 95% CI)

| variant | topic | buried | gist | detail | detail-multichunk | real nDCG@5 |
|---|---|---|---|---|---|---|
| **v1 (prod)** | 0.935 | 0.448 | 0.736 | 0.453 | 0.426 | 0.764 |
| v1+prefix | 0.937 | 0.430 (−0.017, CI to 0.000) | 0.748 ▲ | 0.463 | 0.507 ▲ | 0.783 |
| v2bf16 | 0.933 | 0.477 (+0.029) | 0.737 | **0.533 ▲** | 0.500 ▲ | 0.783 |
| **v2bf16+prefix** | 0.935 | **0.483 ▲** | 0.746 | 0.515 ▲ | **0.532 ▲** | 0.784 |
| v2nvfp4+prefix | 0.926 | 0.493 ▲ | 0.752 | 0.519 ▲ | 0.517 ▲ | 0.817 |
| v1+prefix@256 | 0.920 ▼ | 0.380 ▼ | 0.747 | 0.404 ▼ | 0.418 | 0.769 |
| v2bf16+prefix@256 | 0.917 ▼ | 0.429 | 0.740 | 0.505 ▲ | 0.541 ▲ | 0.771 |

R@1 for the probes that matter most:

| | buried R@1 / R@5 | detail R@1 / R@5 | detail-multichunk R@1 / R@5 |
|---|---|---|---|
| v1 | 33.3% / 56.1% | 36.0% / 56.5% | 29.7% / 59.4% |
| v2bf16+prefix | 36.3% / 62.1% | 42.5% / 63.5% | 45.3% / 65.6% |

Full output (all R@1/R@5/CIs): rerun `node server/ab_embed.js`. It reads from cache in seconds.

### Operations (M1 Max, Ollama 0.40.1, each model loaded alone; two runs)

> ⚠ **Superseded:** the residency column below is a single post-workload snapshot, which is unreliable for MLX. The authoritative numbers are the 3-round peak/settled table in [bf16 vs nvfp4](#bf16-vs-nvfp4-head-to-head-2026-10-09). Latency and throughput here still hold.

| | resident after 1 query | **resident after real chunks** | query p50 / p95 | cold load | corpus embed |
|---|---|---|---|---|---|
| v1 | 0.75 GB | **2.29 / 2.29 GB** | 16–18 / 25 ms | 0.85 s | 15.4 chunks/s (71 s) |
| v2 bf16 | 0.73 GB | **0.94 / 0.81 GB** | 21–23 / 26–29 ms | 0.97 s | 10.9–11.8 chunks/s (~95 s) |
| v2 nvfp4 | 0.54 GB | 1.88 / 2.05 GB | 23–27 / 29–32 ms | 0.97 s | 9.3 chunks/s (~118 s) |

Residency = `phys_footprint` + mapped file, as BenchLLAMA measures it. "After real chunks" = after the 20 longest chunks in the corpus, which is what any sync sends. The idle number alone is misleading: v1 triples, and nvfp4 nearly quadruples.

---

## Interpretation

1. **Why BenchLLAMA's probe and ours disagree.** Its tail probe puts one fact at the end of *repetitive filler*. The fact is the only distinctive thing in the document, so it's a pure test of attention dilution, and v1 wins it. Our chunks are dense, varied notes where the fact sits among related facts. There, v2's better semantic similarity (STS ρ 0.949 vs 0.908 in BenchLLAMA) seems to dominate. The worst case was a fair warning; it just isn't our case.
2. **Where v2's gain lands is the useful part.** Topic and gist queries already sit near the ceiling for both models. The gain is on **specific facts**, and largest when the fact lives past chunk 1 (multi-chunk R@1 30% → 45%). Those are the "how did we fix X" lookups MemoryCentral exists for.
3. **Prefixes are model-dependent.** v2 was evidently trained to lean on them: buried and multi-chunk both improve. On v1 they help paraphrased multi-chunk queries but slightly hurt verbatim buried sentences. Adopt them *with* v2. Applied to v1 alone, the gain is unproven.
4. **bf16 over nvfp4** is a lean, not a clear win. See the head-to-head below. (An earlier version of this point said nvfp4's residency advantage disappears under load. That was a measurement artifact.)
5. **The real-query result is consistent with the rest but weak on its own** (n=34, wide CIs). It shows no regression, and it isn't the evidence the decision rests on.

## bf16 vs nvfp4 head-to-head (2026-10-09)

Both tags are MLX (safetensors). `embeddinggemma-2:270m` is **nvfp4**, 378 MB on disk. `embeddinggemma-2:270m-bf16-text` is unquantized **bf16**, 574 MB. Both have the same architecture, window and 768-dim output. Corpus at this point: 679 memories → 1,094 chunks.

### Quality: a tie

Δ MRR vs **v2bf16+prefix** (the recommended config), 95% paired-bootstrap CI:

| | topic | buried | gist | detail | detail-multichunk | real nDCG@5 |
|---|---|---|---|---|---|---|
| v2bf16+prefix | 0.935 | 0.482 | 0.746 | 0.515 | 0.532 | 0.782 |
| v2nvfp4+prefix | −0.008 [−0.017, −0.000] | +0.010 [−0.004, +0.024] | +0.006 [−0.001, +0.014] | +0.004 [−0.013, +0.022] | −0.015 [−0.048, +0.014] | +0.031 [−0.001, +0.067] |
| v2bf16 (no prefix) | −0.003 | −0.006 | −0.009 | +0.018 | −0.032 | +0.001 |
| v2nvfp4 (no prefix) | −0.005 | +0.019 | −0.009 | +0.014 | −0.042 ▼ | +0.001 |

Five of six probes are within noise. One topic delta is borderline, and it's 0.008 MRR. Rank agreement, bf16+prefix vs nvfp4+prefix:

| | topic | buried | gist | detail | detail-multichunk | real |
|---|---|---|---|---|---|---|
| same top-1 | 95.1% | 76.7% | 98.0% | 84.0% | 82.8% | 91.2% |
| top-5 overlap | 84.7% | 77.1% | 85.1% | 78.9% | 77.5% | 87.1% |

Same-chunk vector cosine is 0.984 mean (p5 0.980, min 0.973). The quantization moves vectors enough to reshuffle borderline rankings, mostly on single-fact queries, but neither quant wins those reshuffles systematically. The prefixes matter more than the quant: dropping them costs both quants on multi-chunk facts.

### Performance: 3 interleaved rounds, median (min–max)

| | idle | **peak during chunks** | **settled (3 s after)** | query p50 / p95 | batched q/s | chunks/s | tok/s | cold load |
|---|---|---|---|---|---|---|---|---|
| v1 (reference) | 0.75 GB | 2.37 (2.37–2.38) | **2.37 (2.37–2.37)** | 18 / 23 ms | 95 | 14.1 | 11,941 | 849 ms |
| **v2 bf16** | 0.74 GB | **2.76 (2.75–2.77)** | **0.73 (0.72–0.73)** | 22 / 28 ms | **71** | **12.0** | **10,145** | 976 ms |
| v2 nvfp4 | 0.54 GB | 3.16 (3.15–3.17) | **0.51 (0.51–0.52)** | 23 / 30 ms | 61 | 9.9 | 8,374 | 967 ms |

Measured with `node server/ab_embed.js --ops --models v1,v2bf16,v2nvfp4 --rounds 3`. Each round loads each model alone, in rotated order. The workload is 100 single queries, the same 100 batched by 32, 157 chunks (every 7th, so the corpus length mix), then the 60 longest chunks, with the footprint sampled continuously for the peak.

- **Runner behaviour is the real story.** llama.cpp (v1) grows its compute buffers to fit the longest input and keeps them for the life of the load (30 min `keep_alive`). MLX (v2) allocates per batch and frees afterwards. nvfp4's higher peak is consistent with dequantization scratch on top of the activations.
- **On an M1 Max, nvfp4 is slower, not faster:** −18% chunks/s, −14% batched queries. There's no fp4 hardware, so the weights are dequantized on the fly. Single-query latency is a tie (≈ 1 ms).
- **What the 0.2 GB means.** It's resident for 30 minutes after every use. The 0.4 GB peak difference lasts only for the seconds a sync is embedding, but that's also when `EXTRACT_MODEL` may be cold-loading.

### Verdict

**bf16, by a small margin.** It's faster on the one path where speed is measurable (a sync re-embedding changed memories), has the lower peak at the moment memory is tightest, and quality is a wash. nvfp4 is a defensible choice if steady-state residency on the 24 GB fleet machines is the priority: −0.2 GB at rest and −196 MB on disk. Either way the switch from v1 is the big win, ~1.6 GB at rest. The quant choice is about a tenth of that.

## Caveats

- One machine, one run per probe. Probes are deterministic given the cache, but the quality numbers have no run-to-run variance estimate. The residency numbers were repeated twice.
- The authored queries and the relevance judgments are LLM-written (blind to models, but one model family). Self-retrieval also counts a near-duplicate memory as a miss, which caps gist R@1 near 70% for every variant.
- `num_ctx: 8192` is in every v2 call, as BenchLLAMA requires (without it, v2 cuts inputs over 8K to 2,048 tokens). It's irrelevant at today's 1.6K-token max chunk but mandatory if chunks ever grow.

---

## What a switch would involve (not done)

1. `embed.js`: `EMBED_MODEL = 'embeddinggemma-2:270m-bf16-text'`, `options: { num_ctx: 8192 }` on `/api/embed`. Also an `embed(text, { kind: 'query' | 'document', title })` split so documents get `title: … | text: …` and queries get `task: search result | query: …`. Callers: `backlog.js`/`chunk.js` (documents) and `index.js` `find_similar` (query).
2. The model change alone marks every vector stale (the backlog keys on model). But if the prompt convention is ever toggled *without* a model change, `embedHash` won't see it, so fold the convention into the hash as part of this change.
3. Back up the DB (WAL checkpoint first), then `node server/reembed.js`. That's 1,093 chunks, about 95 s.
4. `manifest.js` → BenchLLAMA sees the new pin. Restart the MCP server so live tools load the new `embed.js`.
5. Update `EMBED_KEEP_ALIVE`'s "673 MB" note and the CLAUDE.md stack line.

Rollback = revert + `reembed.js` again (~70 s).
