# Troubleshooting

Start with the dashboard (`node setup.js`, then **Settings**). It shows:

- the search engine and model, and whether the model can run on this machine;
- how many memories are waiting for semantic indexing;
- every memory folder and its status.

## The AI tool doesn't see MemoryCentral

- Restart the app, or reload its MCP servers, after registering it.
- Use the snippets from **Connect your apps**: absolute paths, correctly escaped. A bare `node` often fails in apps launched from the Dock, Start menu or an IDE, because they don't inherit your terminal's `PATH`.
- After upgrading or switching Node (for example with nvm), the old path no longer exists. Re-copy the snippet.
- Node 22 or newer is required.

## The AI has the tools but doesn't use them

- Check that the app supports MCP server instructions; Claude Code, Codex and VS Code do.
- If it doesn't, add one line to the app's own user-level instructions: "Before a feature, fix or research task, check MemoryCentral for prior work." Keep it out of the repository, where it would reach people who don't run MemoryCentral.
- Add the [project block](project-block.md) so the AI knows the project's stack tags for `find_by_stack`.

## Answers say "setup isn't finished"

Run `node setup.js` in the MemoryCentral folder and complete the steps. Until then, MemoryCentral works on defaults, but semantic search may not.

## Semantic search says "degraded" or memories are "pending embedding"

The message names the cause:

| Reason | Meaning | Fix |
|---|---|---|
| `provider_down` | Nothing answering at the Ollama address | Start Ollama, or switch to the built-in engine in Settings |
| `model_missing` | The model isn't installed | `ollama pull <model>` (the message names it), or use Settings → Change |
| `model_unsupported` | An MLX-only model on a machine that can't run it | Settings → Change; only models that can run here are offered |
| `timeout` | Ollama was slow, usually loading a model | It retries on its own |
| `local_load_failed` | The built-in model couldn't be downloaded or loaded | Check the network, then Settings → Change → Download again |
| `stale_code` | This app's MemoryCentral server runs older code than your index (after a `git pull`) | Restart the app or reconnect its MemoryCentral server; it refuses to embed so it can't undo the newer setup |

Pending memories are embedded automatically once the cause is fixed: every server retries every minute. Keyword search (`search_memories`) is never affected.

## A folder shows "Held", "Unreadable" or "Folder gone"

See [storage-and-retention.md](storage-and-retention.md). In every case nothing has been removed.

- **Held:** many files vanished at once. If you meant it, click *Confirm removals*. If not, put the files back.
- **Unreadable:** a permissions problem or a disconnected drive. It is re-checked on every sync.
- **Folder gone:** the memories are still searchable. *Keep in MemoryCentral* copies them into its own store.

## A project has no description, or the wrong name

Add a [project block](project-block.md). The `Project:` line sets the name and `Description:` sets the description. Settings → *Project blocks* has a prefilled one for every project.

## The dashboard port is taken

Another MemoryCentral process (a connected AI tool's server) is probably already serving it. `node setup.js` detects that and opens the running one. To use a different port, set `MC_DASHBOARD_PORT`.

## Upgrading from a version before October 2026

The first start of the new version:

- moves the index from `<clone>/stats/knowledge.db` to `~/.memorycentral/memorycentral.db`, keeping the old file as a backup;
- imports `~/.memorycentralrc.json`;
- marks setup as already done.

Reconnect each AI tool's MemoryCentral server, or restart the tool, so none keeps running the old code.
