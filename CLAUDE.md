# MemoryCentral

One memory for every project and every AI tool on this machine: a harness-agnostic MCP server plus a local dashboard.

## Stack
node, sqlite, mcp, javascript

## MemoryCentral
Project: MemoryCentral
Description: Harness-agnostic memory for every project and AI tool: an MCP server, SQLite index and local dashboard.
Stack: node, sqlite, mcp, javascript
Use: Before a feature, fix or research task, check MemoryCentral for prior work (find_similar with a one-line task; find_by_stack per Stack tag). Save decisions, fixes and gotchas with save_memory (project "MemoryCentral").

## Purpose

Any AI tool (Claude Code, Copilot, Codex, OpenCode, …) can save to and search one shared memory over MCP. Existing harness memories (Claude Code's `~/.claude/projects/*/memory`) are ingested in place, and new ones keep flowing in. People browse it on the dashboard.

## Architecture

Full description in `docs/architecture.md`. The short version:

- **Data root** `~/.memorycentral/` (`MEMORYCENTRAL_HOME`): `memorycentral.db`, MemoryCentral's own memories in `projects/<dir>/memory/`, built-in models, generated snapshots. Independent of the clone. The legacy `<clone>/stats/knowledge.db` is moved there once (`server/db.js`).
- **Sources** (`server/sources.js`): `claude` (read in place), `native` (MC's store), `dir` (registered folders). Files are the truth; the DB is a rebuildable index.
- **Ingest** (`server/ingest.js` `syncAll`): reconciliation with retention rules. An unreadable or missing folder NEVER deletes. A single removed file is tombstoned for 30 days. A mass disappearance is held for confirmation. Renames keep their rows and vectors. A cross-process sync lease applies. The MCP server syncs at boot and every 5 min; the Stop hook is optional.
- **Writes** (`server/store.js`): `save_memory` creates projects and updates an existing memory where it lives (no forked copies); `delete_memory` is the deliberate delete.
- **Settings** live in the DB (`server/settings.js`), shared by every process, re-read on a 10 s TTL. Precedence: env > DB > platform default.
- **Embeddings** (`server/embed.js`, `server/models.js`): engine `ollama` or `local` (transformers.js), chosen in onboarding, never auto-switched. Every model in `models.js` carries its prompt convention, options, MLX-only flag and chunk size. The vector-space id encodes all of them, so a change re-embeds via the backlog. Ollama defaults: `embeddinggemma-2:270m-bf16-text` on Apple Silicon with local Ollama, `embeddinggemma:300m` elsewhere (every v2 tag is MLX). Rationale: `docs/embedding-eval-2026-10-09.md`.
- **Project metadata** precedence: `## MemoryCentral` block > `set_project_info` from an AI tool > optional Ollama auto-description (`server/extract.js`, OFF by default, user-enabled in Settings, only fills gaps, re-runs only on changed memories) > README fallback. `projects.meta_source` records which won.
- **MCP server** (`server/index.js`): harness-neutral `instructions` (`server/instructions.js`, 512-char self-contained lead, ≤2,048 total), tools in `docs/mcp-tools.md`.
- **Dashboard** (`server/dashboard.js`, `server/setupApi.js`, `server/public/`): browse, onboarding, settings. Every request must carry a localhost Host header; every write needs the per-launch token. `node setup.js` serves it standalone.

## Notes

- Never let a source scan failure cascade into deletions. The retention rules exist because MemoryCentral must retain knowledge.
- Tests run against throwaway data roots: `cd server && npm test`. Set `MEMORYCENTRAL_HOME` for any ad-hoc script so it can't touch the real index.
- Measure embedding changes with `server/ab_embed.js` (chunk-faithful, read-only). Measure residency as peak **and** settled, never as one snapshot.
- The consumer manifest (`server/manifest.js`) tells BenchLLAMA which Ollama model is in use, or none on the built-in engine.
