# Using MemoryCentral well

MemoryCentral does two jobs:

1. **Recall.** It keeps every memory from every project and AI tool searchable in one place. This works as soon as it's set up.
2. **Reuse.** It surfaces a prior solution while you work, before anyone re-solves a problem, re-searches the web or guesses. This depends on the AI tool knowing *when* to look.

## Making the AI look first

Three layers, from broadest to most specific:

1. **Server instructions.** These are automatic. Every app that supports MCP server instructions (Claude Code, Codex, VS Code) is told to search MemoryCentral before implementing, fixing or researching, and to save what it learns.
2. **The project block.** Add one per project ([project-block.md](project-block.md)). Its `Stack:` line lets the AI search for prior work on the same technologies (`find_by_stack`). Its `Use:` line is the per-project nudge, read with the project's own instructions in every session.
3. **Your own words.** "How did we do X before?" or "check MemoryCentral for…" always works.

## What to save

A memory earns its place if a future session couldn't work it out from the code or git history:

- **Decisions and their reasons:** "chose SQS over Redis streams because…"
- **Root causes:** "the 502s were the proxy's 60 s idle timeout, not the app"
- **Gotchas and constraints:** "this API rate-limits per token, not per IP"
- **Preferences and feedback:** "keep PRs under 300 lines", "never edit generated files"
- **Pointers:** "the staging dashboards are at …"

Leave out what the repository already records: code structure, routine changes, anything `git log` answers.

Write one memory per file, with a descriptive filename and frontmatter:

```markdown
---
name: proxy-idle-timeout-502s
description: Intermittent 502s were the reverse proxy's 60s idle timeout on long exports
type: project
---

Long CSV exports returned 502 after ~60 s. Cause: the proxy closes idle upstream connections at 60 s…
**Fix:** stream the response…
```

`type` is one of `feedback`, `project`, `user` or `reference`. The dashboard groups memories by it.

## Searching

| Looking for | Use |
|---|---|
| "How did we handle …" (an idea, in any words) | `find_similar` |
| A name: library, error text, command, file | `search_memories` |
| "What have we built with Swift?" | `find_by_stack` |
| Everything about one project | `get_project_summary`, then `get_project_memories` |

On the dashboard, the search box (⌘K / Ctrl+K) does keyword search across everything.

## Keeping it tidy

- Correct a memory by saving it again under the same filename. It is updated in place.
- Remove a memory that is wrong or no longer true with `delete_memory`, or delete it on the dashboard.
- Deleting a memory file by hand also works. It is removed from search on the next sync and can be restored for 30 days from Settings → *Recently deleted*.
