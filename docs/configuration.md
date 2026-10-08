# Configuration

Everything is configured on the dashboard: `node setup.js`, then **Settings**. Settings are stored in MemoryCentral's database. That way every process shares them: each connected AI tool's server, the dashboard, and sync. A change takes effect everywhere within about 10 seconds, with no restart.

Environment variables override settings. That is useful for testing, or for pinning one install.

## Settings (set on the dashboard)

| Setting | Values | Default |
|---|---|---|
| Search engine (`embed.provider`) | `ollama`, `local` (built-in) | `ollama` |
| Ollama address (`ollama.host`) | URL | `http://localhost:11434` |
| Ollama model (`embed.ollama.model`) | an embedding model tag | depends on the platform, see below |
| Built-in model (`embed.local.model`) | a built-in model id | see [embedding-eval-2026-10-09.md](embedding-eval-2026-10-09.md) |
| Stack overrides (`stack.overrides`) | `{ "Project": ["tag", …] }` | none |

### Which Ollama model by default

| Where Ollama runs | Model |
|---|---|
| Apple Silicon Mac, local Ollama | `embeddinggemma-2:270m-bf16-text` (MLX) |
| Windows, Linux, Intel Mac, or any remote Ollama | `embeddinggemma:300m` |

Every `embeddinggemma-2` build is MLX, which Ollama runs only on Apple Silicon. A remote Ollama gets the model that runs everywhere, because MemoryCentral can't see what platform it is on. Choosing an MLX model where it can't run is refused, naming the right model.

Changing the engine or model re-indexes every memory in the background. Keyword search is unaffected meanwhile.

## Environment variables

| Variable | Effect |
|---|---|
| `MEMORYCENTRAL_HOME` | Data folder (default `~/.memorycentral`) |
| `EMBED_PROVIDER` | Overrides the search engine (`ollama` \| `local`) |
| `EMBED_MODEL` | Overrides the Ollama model |
| `EMBED_LOCAL_MODEL` | Overrides the built-in model |
| `OLLAMA_HOST` | Overrides the Ollama address |
| `MC_DASHBOARD_PORT` | Dashboard port (default 9980) |
| `MC_SYNC_INTERVAL_MS` | How often a running server re-syncs (default 5 minutes) |
| `EMBED_TIMEOUT_MS` | Abort budget for one embedding request (default 30 s) |
| `EMBED_KEEP_ALIVE` | How long Ollama keeps the embedding model loaded (default `30m`) |
| `EMBED_CHUNK_CHARS` / `EMBED_CHUNK_OVERLAP` | Default chunk size and overlap for models without their own |
| `MC_CLAUDE_PROJECTS` | Where Claude Code keeps its project folders (default `~/.claude/projects`) |

To set one for an AI tool's MemoryCentral server, add an `env` block to that tool's MCP registration.

## Registering extra memory folders

A project can have memory folders beyond its AI tool's own, for example a `memory-bank/` folder inside the repository, as Cline and Cursor workflows often use. Earlier versions took these as `extraPaths` in `~/.memorycentralrc.json`.

That file is imported once, automatically, into the database. Its `embedProvider`, `stackOverrides` and `extraPaths` become settings and registered folders. It is not read again after that.
