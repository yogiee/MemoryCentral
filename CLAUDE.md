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
- `nomic-embed-text` — vector embeddings for semantic search (Tier 1, recommended)
- `llama3.1` — auto-extracts project descriptions and stack tags during sync
- Falls back to `@huggingface/transformers` (Tier 2) or in-context Claude matching (Tier 3) if Ollama is unavailable

### MCP server
- Node.js server (`server/index.js`) registered globally via `claude mcp add --scope user`
- Exposes 9 tools available in every Claude session
- Dashboard auto-starts at `http://localhost:9980` alongside the MCP server

## Notes

- Ollama is best for background processing; don't try to replace Claude for quality synthesis tasks
- The MCP server's data directory should always point at the Git-cloned path so a `git pull` is the only restore step needed on a new machine
