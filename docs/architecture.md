# Architecture

MemoryCentral is one memory for every project and every AI tool on a machine. AI tools reach it over MCP. People reach it through a local dashboard. Everything runs locally, and the data is plain Markdown plus one SQLite file.

This page describes every component and how they fit together. Topic guides:

- [connecting-apps.md](connecting-apps.md): registering MemoryCentral in each AI tool
- [mcp-tools.md](mcp-tools.md): what each tool does
- [project-block.md](project-block.md): the per-project `## MemoryCentral` block
- [storage-and-retention.md](storage-and-retention.md): where files live and when anything is removed
- [configuration.md](configuration.md): settings and environment variables
- [troubleshooting.md](troubleshooting.md)

```
 AI tools (Claude Code, Copilot, Codex, OpenCode, …)          You
        │  MCP over stdio — each tool starts its own server       │  browser
        ▼                                                         ▼
 ┌─────────────────────────┐                        ┌──────────────────────────┐
 │ server/index.js         │                        │ server/dashboard.js      │
 │ MCP server              │──── same process ─────▶│ http://localhost:9980    │
 │  tools · instructions   │   (or standalone via   │  browse · search · setup │
 │  background sync        │    node setup.js)      │  settings                │
 └───────────┬─────────────┘                        └────────────┬─────────────┘
             │                                                   │
             ▼                                                   ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ store.js (writes) · ingest.js (sync + reconciliation) · embed.js (vectors)    │
 └───────────┬───────────────────────────────┬──────────────────────────────────┘
             ▼                               ▼
 ┌──────────────────────────┐   ┌────────────────────────────────────────────┐
 │ ~/.memorycentral/        │   │ Memory sources (Markdown files)            │
 │  memorycentral.db        │◀──│  claude  ~/.claude/projects/*/memory       │
 │   memories · FTS5        │   │  native  ~/.memorycentral/projects/*/memory│
 │   vectors · settings     │   │  dir     any folder you register            │
 │   sources · tombstones   │   └────────────────────────────────────────────┘
 └──────────────────────────┘
```

## Principles

- **Files are the source of truth.** Every memory is a Markdown file somewhere. The database is an index that can always be rebuilt from the files, which is what `import.js` does.
- **Harness-agnostic.** Nothing depends on a particular AI tool. Claude Code's memory folders are one *source* among several, and any tool that speaks MCP can read and write.
- **Knowledge is retained.** Nothing is removed because a folder went missing or couldn't be read. Only a deliberate deletion takes a memory out of search, and even then it can be restored for 30 days. See [storage-and-retention.md](storage-and-retention.md).
- **No silent degradation.** Every failure says what it was: a missing model, a stopped service, a timeout. A failed embedding leaves the memory pending, and it is retried automatically.

## Components

### Data root: `server/paths.js`

Everything MemoryCentral owns lives under `~/.memorycentral/`, or `MEMORYCENTRAL_HOME` if set. This is independent of where the repository is cloned.

| Path | What it is |
|---|---|
| `memorycentral.db` | The index (below) |
| `projects/<dir>/memory/*.md` | Memories MemoryCentral owns: everything saved through MCP for projects that have no folder of their own |
| `projects/<dir>/project.json` | That project's real name; `<dir>` is sanitised so it is valid on every OS |
| `models/` | Built-in embedding models, downloaded once |
| `generated/` | `DASHBOARD.md` and per-project snapshots, rebuilt each sync |

Before 2026-10-09 the index lived at `<clone>/stats/knowledge.db`. It is moved to the data root automatically the first time a new version starts, and the old file is kept as a backup.

### The index: `server/db.js`

One SQLite file in WAL mode, safe to share between processes.

| Table | Contents |
|---|---|
| `projects` | Name, description, stack tags, repository path, which instructions file carries its block |
| `sources` | Every memory folder: kind (`claude` / `native` / `dir`), path, status (`ok`, `unavailable`, `missing`, `suspect`) |
| `memories` | One row per memory file: content, title, type, owning source, content hash |
| `memories_fts` | FTS5 full-text index over title and content |
| `embeddings` | One vector per *chunk* of a memory, tagged with the vector space it belongs to |
| `memory_tombstones` | Memories removed from search, restorable until purged |
| `settings` | Shared configuration (embedding engine, model, Ollama host, …) |
| `sync_events` | History of syncs, for the dashboard |

The schema migrates in place: an index from an older version keeps every row id and every vector.

### Sources: `server/sources.js`

A source is one folder of Markdown memories belonging to one project. Each kind has an adapter that finds its folders:

- **`claude`:** Claude Code's per-project memory folders. A folder name encodes the repository's path; `server/paths.js` decodes it, backtracking past ambiguous hyphens, to recover the project name and repository.
- **`native`:** MemoryCentral's own store. Memories saved through MCP for projects with no folder elsewhere land here.
- **`dir`:** Any folder you register for a project. These were previously `extraPaths` in `~/.memorycentralrc.json`, which is imported once.

Adding another tool's on-disk memory format means adding an adapter with the same two operations: find the folders, then read them in full.

### Ingest and reconciliation: `server/ingest.js`

`syncAll()` brings the index in line with every source:

1. Discover every source folder.
2. Read each folder in full. If any part can't be read, the folder is marked unavailable and left untouched.
3. Reconcile each folder against the index:
   - new files are added
   - changed files are updated
   - renamed files (same content, new name) keep their row and vectors
   - files removed from a readable folder are tombstoned
   - a mass disappearance is held for confirmation
4. Mark folders that have vanished entirely as `missing`. Their memories stay searchable.
5. Purge tombstones older than 30 days.
6. Refresh each project's name, description and stack from its [project block](project-block.md).
7. Embed whatever changed, then anything still pending.

A sync **lease** in the settings table means only one process syncs at a time. That matters because every connected AI tool runs its own server.

Syncs happen:

- when an MCP server starts, then every 5 minutes;
- from the dashboard's sync button;
- from the `sync` tool;
- from `node sync.js`;
- optionally, from Claude Code's Stop hook.

### Writes: `server/store.js`

The write operations the MCP tools and the dashboard share. Each one writes the file first, then updates the index.

- **`saveMemory`:** creates the project if it is new. An existing memory is updated **where it lives**, including a file an AI tool just wrote that the index hasn't seen yet, so saving the same memory from two places never forks a copy. A new memory goes to MemoryCentral's own store. Filenames are validated: one plain `.md` name, no path separators.
- **`deleteMemory`:** a deliberate delete that removes the file and the memory.
- **Other operations:**
  - `restoreTombstone`: brings a tombstoned memory back.
  - `confirmHeldRemovals`: applies removals that were held after a mass disappearance.
  - `adoptSource`: copies a vanished folder's memories into the store as files.

### Embeddings: `server/embed.js`, `server/models.js`, `server/chunk.js`, `server/backlog.js`

Semantic search compares a query vector against the vectors of every memory chunk.

- **Engines.** *Ollama* is a local or remote server and gives the best quality. *Built-in* runs ONNX models in-process via transformers.js: no install, CPU only. The choice is a setting made during onboarding and is never switched automatically. A failing engine leaves memories pending rather than mixing vector spaces.
- **Models** (`models.js`). A single table lists every model with:
  - its prompt convention (some models are trained with task prefixes);
  - its Ollama options;
  - whether it is MLX-only (Apple Silicon only);
  - its chunk size.

  Suggestions, warnings and the onboarding page all read from this table, so MemoryCentral never recommends a model the machine can't run.
- **Chunking** (`chunk.js`). Long memories are split at headings and paragraphs into overlapping chunks, sized to the model's context window. A memory scores as its best-matching chunk.
- **Vector spaces.** Every vector is stored under an id naming its model, prompt convention and chunk size. Changing any of them makes every old vector stale, and the **backlog** (`backlog.js`) re-embeds them in the background. Search only ever compares vectors from the same space.
- **Settings are re-read every 10 seconds**, so a change on the dashboard reaches every running server without a restart.
- **Code-level changes** to the model table (chunk size, prompts, defaults) bump `MODELS_REVISION`. The newest revision that has run is recorded in the DB. A server still running older code stops embedding and asks to be restarted, rather than re-embedding the index back into the old vector space.

The models were chosen by measurement on a real corpus. See [embedding-eval-2026-10-09.md](embedding-eval-2026-10-09.md).

### Project metadata: `server/projectBlock.js`, `server/extract.js`

A project's name, description and stack come from, in order:

1. its `## MemoryCentral` block;
2. an AI tool, via `set_project_info`;
3. optionally, a local Ollama model (`extract.js`), off by default and turned on in Settings, which only fills gaps;
4. its README.

`projects.meta_source` records which won, so a guess never overwrites a deliberate value. See [project-block.md](project-block.md).

### MCP server: `server/index.js`, `server/instructions.js`

A stdio MCP server. Each AI tool starts its own copy. At startup it:

- sends **instructions** that tell every connected tool when to use MemoryCentral (supported by Claude Code, Codex and VS Code);
- registers the tools ([mcp-tools.md](mcp-tools.md));
- starts the background sync and the embedding backfill loop;
- starts the dashboard on port 9980, or stands by if another process already serves it.

### Dashboard: `server/dashboard.js`, `server/setupApi.js`, `server/public/`

A local web app with no build step:

- **Browse:** projects grouped by stack, memories by type, full-text search with highlighted excerpts, memory detail.
- **Onboarding:** shown until setup is finished.
- **Settings:** engine and model, connecting apps, project blocks, memory sources with their status, recently deleted memories.

It binds to `127.0.0.1` only. Every request must carry a `localhost` Host header, which defeats DNS rebinding. Every change must carry a per-launch token that only the dashboard's own page has.

`node setup.js` runs the dashboard on its own. Use it for first-time setup, or to browse memories without any AI tool open.

### Connecting apps: `server/connect.js`

Generates ready-to-paste registrations for Claude Code, VS Code (Copilot), Codex and OpenCode, with this machine's absolute paths escaped for each format. See [connecting-apps.md](connecting-apps.md).

### Backup and restore: `server/backup.js`, `export.js`, `import.js`

A backup is taken from the index, so it contains every memory from every source, including memories whose folder no longer exists anywhere else, along with projects, sources, recently deleted memories and settings. Restore puts each file back in its original folder if that exists on the machine, and into MemoryCentral's store otherwise, then rebuilds the index.

### Consumer manifest: `server/manifest.js`

Publishes which Ollama model MemoryCentral relies on to `~/.config/ollama-consumers/memoryCentral.json`. A local benchmarking tool (BenchLLAMA) reads it so it doesn't drop a model in use. See [consumer-manifest.md](consumer-manifest.md).

### Diagnostics

- **`server/ab_embed.js`:** the embedding A/B harness. It is read-only and chunk-faithful, and covers quality probes, resident memory and throughput.
- **`server/reembed.js`:** re-embeds every memory with the active model.
