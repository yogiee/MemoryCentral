# MemoryCentral

Cross-project knowledge bank for all local Claude Code sessions. Aggregates memory files from every Claude project into a searchable SQLite database, exposed via a global MCP server.

## What it does

- Harvests `~/.claude/projects/*/memory/*.md` from all Claude project sessions
- Stores everything in SQLite with full-text search (FTS5) and semantic embeddings
- Exposes 8 MCP tools available in **every** Claude session, globally
- Auto-syncs after each session via a Stop hook (async, non-blocking)
- Generates per-project snapshot files committed to Git for human-readable diffs

## Architecture

```
~/.claude/projects/<project>/memory/*.md   ← Claude writes here (per project)
              ↓  sync.sh (Stop hook + manual)
stats/knowledge.db                         ← SQLite: FTS5 + embeddings
              ↓  MCP server (server/index.js)
Any Claude session                         ← search, read, write cross-project
              ↓  save_memory tool
~/.claude/projects/<project>/memory/*.md   ← also writes back to filesystem
snapshots/<project>.md                     ← committed to Git
dashboard/DASHBOARD.md                     ← committed to Git
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_projects` | All tracked projects with description, stack tags, memory count |
| `get_project_summary` | Structured overview of one project: description, stack, memory list by type |
| `get_project_memories` | Full content of all memory files for a project |
| `search_memories(query, project?)` | FTS keyword search across all projects (or one) |
| `find_similar(description)` | Semantic search via nomic-embed-text embeddings |
| `find_by_stack(tag)` | All projects using a given tech tag (swift, node, python…) |
| `save_memory(project, filename, content)` | Write a memory mid-session — filesystem + DB + embeddings |
| `get_dashboard` | Cross-project dashboard grouped by primary stack tag |
| `sync` | Trigger a full harvest from all Claude project sessions |

## Setup (new machine)

```bash
git clone git@github.com-personal:yogiee/MemoryCentral.git
cd MemoryCentral
npm install
```

Register the MCP server globally using the CLI (**not** by editing `settings.json` — Claude Code reads global MCP servers from `~/.claude.json`):

```bash
claude mcp add --scope user memoryCentral /opt/homebrew/bin/node /absolute/path/to/MemoryCentral/server/index.js
```

Verify it connected:

```bash
claude mcp list
# memoryCentral: /opt/homebrew/bin/node ... - ✓ Connected
```

Add the Stop hook to `~/.claude/settings.json` so the DB syncs after every session:

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "bash /absolute/path/to/MemoryCentral/sync.sh --no-commit",
        "async": true
      }]
    }]
  }
}
```

Run the first sync to populate the DB:

```bash
./sync.sh
```

### Global CLAUDE.md (required for proactive cross-project awareness)

Create `~/.claude/CLAUDE.md` with the following content. This file is loaded into every Claude session and instructs Claude to use MemoryCentral tools proactively:

```markdown
# Global Instructions

## MemoryCentral — Cross-Project Knowledge Bank

All local Claude projects are indexed in a central SQLite DB with FTS and semantic search.
MCP server: `memoryCentral` (available in every session).

### Search before researching

When working on a technical problem — especially implementation patterns, architecture decisions,
debugging approaches, or anything you might have solved in another project — call
`memoryCentral:search_memories` or `memoryCentral:find_similar` first. Do this proactively
when starting research (web search, reading docs) to avoid repeating prior work.

Good triggers:
- "How did we handle X before?" → `find_similar`
- Researching a library/pattern also used in other projects → `search_memories`
- Starting work on a feature with likely prior art (auth, networking, scroll, UI components) → `find_by_stack` + `search_memories`

### Write memories via MCP

When you save an important memory (feedback, architectural decision, key discovery), also call
`memoryCentral:save_memory` so it's immediately searchable across all projects — don't wait
for the next sync. Use the same filename and content as the memory file you're writing.

memoryCentral:save_memory({
  project:  "ExactProjectName",   // as shown in list_projects
  filename: "feedback_auth.md",
  content:  "---\nname: ...\n---\n\n..."
})

### Available tools

| Tool | Use for |
|------|---------|
| `list_projects` | See all tracked projects with stack + memory count |
| `search_memories(query, project?)` | FTS keyword search across all memories |
| `find_similar(description)` | Semantic search — "how we handled scroll offset" |
| `find_by_stack(tag)` | All projects using swift, node, python, etc. |
| `get_project_memories(project)` | Full memory dump for one project |
| `save_memory(project, filename, content)` | Write memory to DB + filesystem mid-session |
| `sync` | Pull latest memories from all Claude project sessions |
```

## Sync script

```bash
./sync.sh              # harvest + git commit
./sync.sh --no-commit  # harvest only (used by Stop hook)
```

## Stack

- **Node 22+** — `node:sqlite` built-in (no native deps)
- **SQLite** — WAL mode, FTS5, embeddings as JSON
- **Ollama** — `nomic-embed-text` for embeddings, `llama3.1` for project meta extraction
- **MCP** — `@modelcontextprotocol/sdk` stdio transport

## Files not in Git

```
stats/knowledge.db    ← SQLite DB (local only, rebuilt from memory files)
projects/             ← raw memory file copies (intermediate, not needed)
```
