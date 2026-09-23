# MemoryCentral

Central memory and dashboard system for all local Claude Code projects.

## Stack
node, sqlite, mcp, javascript

## Purpose

A meta-project that aggregates, tracks, and surfaces memory snapshots, progress, and context across every Claude project on this machine. Think of it as a personal ops layer sitting above individual project sessions.

## Goals

- Unified view of recent work across all projects (harvested from `~/.claude/projects/*/memory/`)
- Dashboard: cross-project progress, active tasks, key decisions, blocked items
- Usage/effort tracking (sessions, time spent, milestones)
- Easy to back up, restore, and sync between machines
- Available in every Claude session via a global MCP server

## Architecture

### Data layer
- `stats/knowledge.db` — SQLite with FTS5 full-text search and vector embeddings
- `~/.claude/projects/*/memory/*.md` — source of truth; Claude writes here per session
- No proprietary format — all Markdown + SQLite, no lock-in

### Sync
- `sync.js` harvests `~/.claude/projects/*/memory/` into the DB after each session (Stop hook)
- Extra paths per project configurable in `~/.memorycentralrc.json`
- `node export.js` / `node import.js` for backup and machine migration

### Local AI layer (Ollama)
- `embeddinggemma:300m` — vector embeddings for semantic search (Tier 1, recommended; 768-dim, clean to ~8k chars). Switched from `nomic-embed-text` 2026-06-13 — see `docs/embedding-eval-2026-06-13.md`
- `granite4.2:3b` — auto-extracts project descriptions and stack tags during sync (`EXTRACT_MODEL`, 60s abort budget; pinned 2026-09-23 for residency, 2.6 GB vs `gemma4:e4b-mlx`'s 9.4 GB). Only viable because the call sends `num_ctx: 4096` + `think: false` (`EXTRACT_NUM_CTX` / `EXTRACT_THINK`) — without them it's 13.3 GB and thinks past the budget. Pin history: `llama3.1` → `gemma4:latest` → `gemma4:e4b-mlx` → `granite4.2:3b`
- Both pins are published to BenchLLAMA via the consumer manifest (`server/manifest.js` → `~/.config/ollama-consumers/memoryCentral.json`)
- The embedding provider is a setup-time choice (`embedProvider` in `~/.memorycentralrc.json`: `ollama` default, or `local` = `@huggingface/transformers` `all-MiniLM-L6-v2`, Tier 2) — never a runtime fallback. If the provider is down, `find_similar` degrades to in-context Claude matching (Tier 3) and new memories stay pending until the backlog retry embeds them

### MCP server
- Node.js server (`server/index.js`) registered globally via `claude mcp add --scope user`
- Exposes 9 tools available in every Claude session
- Dashboard auto-starts at `http://localhost:9980` alongside the MCP server

## Notes

- Ollama is best for background processing; don't try to replace Claude for quality synthesis tasks
- The MCP server's data directory should always point at the Git-cloned path so a `git pull` is the only restore step needed on a new machine
