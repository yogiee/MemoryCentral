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

## Architecture (decided in kickoff session)

### Data layer
- `projects/` — per-project memory snapshots (Markdown, mirroring each project's memory files)
- `dashboard/DASHBOARD.md` — aggregated cross-project summary, auto-generated
- `stats/stats.db` — SQLite for structured tracking (sessions, effort, time)
- Everything in a private Git repo for portability and sync

### Sync strategy
- Shell script (`sync.sh`) harvests `~/.claude/projects/*/memory/` into `projects/`
- Git-backed: `git push` to sync, `git clone` to restore on a new machine
- No proprietary format — all Markdown + SQLite, no lock-in

### Local AI layer (Ollama)
- Used **between sessions** (not during) for lightweight background tasks:
  - Summarising/deduplicating memory entries before committing
  - Generating embeddings for semantic search across all project memories
  - Nightly aggregation job that refreshes `DASHBOARD.md` without Anthropic API usage
- OpenWebUI's Knowledge feature can index memory files for conversational lookup

### MCP server
- Custom lightweight MCP server (Node or Python) backed by this repo
- Registered globally in `~/.claude/settings.json` so it's available in every project session
- Portability: clone repo on new machine → update one path in settings → done
- Server binary lives inside this repo (no separate install step)

### Project/task context per project
Each `projects/<name>/` snapshot holds:
- Active milestone / sprint
- Open tasks with status
- Blocked items and reasons
- Key architectural decisions
- Links to relevant files / PRs

## Immediate next steps

1. `git init` this directory and create private remote repo
2. Design the `projects/<name>/snapshot.md` schema
3. Write `sync.sh` — the harvester script that reads all project memories and writes snapshots
4. Decide on MCP server language (Node vs Python) and scaffold it
5. Wire up Ollama summarisation step in the sync pipeline
6. Configure global MCP in `~/.claude/settings.json`

## Machine-specific paths

- Claude project memories: `~/.claude/projects/`
- This repo: `~/WORK/Personal-Projects/MemoryCentral/`
- Ollama: running locally (models available for local inference)
- OPNsense / homelab context: see separate homelab projects

## Notes

- Start simple: get the sync script and Git foundation right before building the MCP layer
- Ollama is best for background processing; don't try to replace Claude for quality synthesis tasks
- The MCP server's data directory should always point at the Git-cloned path so a `git pull` is the only restore step needed on a new machine
