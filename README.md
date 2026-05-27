# MemoryCentral

Cross-project knowledge bank for Claude Code. Harvests memory files from every Claude project on your machine into a searchable SQLite database, exposed as a global MCP server.

Works on **macOS, Windows, and Linux**.

## What it does

- Harvests `~/.claude/projects/*/memory/*.md` from all your Claude sessions
- Stores everything in SQLite with full-text search (FTS5) and optional semantic embeddings
- Exposes 9 MCP tools available in **every** Claude session, globally
- Auto-syncs after each session via a Stop hook (async, non-blocking)
- Export/import for machine migration and backup

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 22+** | Required for built-in `node:sqlite`. [nodejs.org](https://nodejs.org) |
| **Claude Code** | The CLI — [claude.ai/code](https://claude.ai/code) |
| **Ollama** _(optional)_ | Enables richer semantic search and project metadata. [ollama.com](https://ollama.com) |

## Install

```bash
git clone <repo-url>
cd MemoryCentral
node setup.js
```

`setup.js` will:
1. Check your Node.js version
2. Install dependencies (`npm install`)
3. Register the MCP server globally (`claude mcp add --scope user`)
4. Print a Stop hook snippet to add to `~/.claude/settings.json`
5. Run the first sync

Then **start a new Claude Code session** — `memoryCentral` tools will be available.

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_projects` | All tracked projects with description, stack tags, memory count |
| `get_project_summary` | Structured overview: description, stack, memory list by type |
| `get_project_memories` | Full content of all memory files for a project |
| `search_memories(query, project?)` | FTS keyword search across all projects (or one) |
| `find_similar(description)` | Semantic search — see [Semantic Search](#semantic-search) below |
| `find_by_stack(tag)` | All projects using a given tech tag (swift, node, python…) |
| `save_memory(project, filename, content)` | Write a memory mid-session — filesystem + DB + embeddings |
| `get_dashboard` | Cross-project dashboard grouped by primary stack tag |
| `sync` | Trigger a full harvest from all Claude project sessions |

## Sync

Sync runs automatically after each session via the Stop hook. To run manually:

```bash
node sync.js
```

## Backup and Restore

### Export

```bash
node export.js
# → memoryCentral-backup-2026-05-28.json.gz
```

Creates a compressed backup of all memory files. Use this before reinstalling your OS or migrating to a new machine.

### Import

```bash
node import.js memoryCentral-backup-2026-05-28.json.gz
```

Restores all memory files and rebuilds the database automatically.

**Same machine / same username:** everything restores in place automatically.

**New machine or new username:** files are restored to the same encoded paths. Claude Code will find them once you open the corresponding projects from the same absolute paths. The import prints a manifest so you can see exactly which projects are in the backup.

---

## Semantic Search

`find_similar` uses vector embeddings to find memories by concept rather than keyword. It works in three modes depending on what's available on your machine:

### Tier 1 — Ollama (recommended for best quality)

If [Ollama](https://ollama.com) is running locally with `nomic-embed-text` installed, it's used automatically.

```bash
ollama pull nomic-embed-text
```

Highest quality embeddings, runs entirely offline, zero API cost.

### Tier 2 — Local model via transformers.js (no setup required)

If Ollama isn't available, MemoryCentral automatically falls back to [`@huggingface/transformers`](https://huggingface.co/docs/transformers.js) running a small quantized model (`all-MiniLM-L6-v2`) directly in Node.js.

- No service to run — the model loads inside the Node process
- First use downloads ~25 MB and caches it locally (one time only)
- Quality is slightly lower than nomic-embed-text but still meaningfully semantic

### Tier 3 — In-context Claude matching (always works)

If neither Tier 1 nor Tier 2 is available, `find_similar` returns all memory content structured for Claude to match using its own understanding. Uses more context window but always works with zero setup.

### Project metadata extraction

When Ollama is running, sync also uses it (via `llama3.1`) to auto-extract human-readable descriptions and stack tags for each project. Without Ollama, descriptions show as `_unknown_` — but all memory content is still fully indexed and searchable.

### Capability summary

| Feature | No Ollama | With Ollama |
|---------|-----------|-------------|
| `search_memories` (keyword) | ✓ Full | ✓ Full |
| `find_similar` (semantic) | ✓ Via transformers.js or Claude | ✓ Best quality |
| Project descriptions + stack tags | ✗ Empty | ✓ Auto-extracted |
| `get_dashboard` | ✓ (no descriptions) | ✓ Full |

---

## Architecture

```
~/.claude/projects/<project>/memory/*.md   ← Claude writes here per session
              ↓  node sync.js  (Stop hook + manual)
stats/knowledge.db                         ← SQLite: FTS5 + embeddings
              ↓  server/index.js  (MCP server)
Any Claude session                         ← 9 tools, cross-project search
              ↓  save_memory tool
~/.claude/projects/<project>/memory/*.md   ← writes back to filesystem
snapshots/<project>.md                     ← local snapshot (gitignored)
dashboard/DASHBOARD.md                     ← local dashboard (gitignored)
```

## What's in git

The repo contains only the **engine** — no personal data is ever committed.

```
server/         MCP server + sync logic
setup.js        One-time setup
sync.js         Stop hook entry point
export.js       Backup utility
import.js       Restore utility
```

Personal data (memories, snapshots, dashboard, database) lives locally and never leaves your machine unless you explicitly run `node export.js` and share the file.

## Stack

- **Node.js 22+** — `node:sqlite` built-in (zero native deps for core)
- **SQLite** — WAL mode, FTS5 full-text search, vector embeddings as JSON
- **@huggingface/transformers** — local embedding fallback (Tier 2), ~25 MB model download on first use
- **Ollama** _(optional)_ — `nomic-embed-text` embeddings, `llama3.1` meta extraction
- **@modelcontextprotocol/sdk** — stdio MCP transport
