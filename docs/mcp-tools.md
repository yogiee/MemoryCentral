# MCP tools

Every connected AI tool gets these tools. They also receive MemoryCentral's server **instructions**, which explain when to use them. Tools that support MCP server instructions include Claude Code, Codex and VS Code. Tool names are shown bare; each app prefixes them its own way (`mcp__memoryCentral__find_similar`, `memoryCentral.find_similar`, …).

## Searching

### `find_similar(description, limit = 5)`
Semantic search across every project: finds memories by meaning, not wording. It is the best tool for "how did we handle X before?".

- Describe the task in one line, e.g. `retry with backoff for a flaky upstream API`.
- Each result shows the matching passage, from the chunk that matched, not just the top of the file.
- If the embedding engine is unavailable, it says why. It then returns every memory's summary so the AI can match by reading instead (*degraded mode*).
- Memories not yet embedded are flagged, and keyword search still covers them.

### `search_memories(query, project?)`
Keyword (full-text) search. Best for named things: a library, an error message, a command, a file name. Hyphenated and quoted text works as typed (`Cache-Control`, `"no such column"`). You can still use `AND`, `OR`, `NOT` and prefix matches like `embed*`.

### `find_by_stack(tag)`
Projects using a technology (`node`, `swift`, `laravel`…), from each project's `Stack:` line. Useful before starting work: "what have we built with this before?"

## Browsing

| Tool | Returns |
|---|---|
| `list_projects` | Every project with description, stack and memory count |
| `get_project_summary(project)` | One project's description, stack and memory titles grouped by type |
| `get_project_memories(project)` | Full content of every memory in one project |
| `get_dashboard` | Cross-project overview grouped by stack |

## Writing

### `save_memory(project, filename, content, project_path?)`
Creates or updates a memory.

- **`project`:** the `Name:` line of the repository's [`## Project` block](project-block.md) if it has one, otherwise the repository folder name. A new project is created automatically.
- **`filename`:** a plain `.md` name such as `feedback_testing.md`, with no folders. Re-saving the same filename updates that memory in place, wherever it lives.
- **`content`:** Markdown. Frontmatter with `name`, `description` and `type` is recommended. The type is one of `feedback`, `project`, `user` or `reference`.
- **`project_path`:** the repository's absolute path, if known. It lets MemoryCentral read the project's block.

What's worth saving: what a future session couldn't work out from the code or git history. That means the reason behind a decision, a fix's root cause, a constraint from outside the code, or a user preference. Routine changes are not worth saving.

### `set_project_info(project, description?, stack?, project_path?)`
Describes a project: one sentence and lowercase stack tags. AI tools are asked to use it when the project they're working in has no description. A [`## Project` block](project-block.md) in the repository takes precedence; the tool's reply says so when one exists.

### `delete_memory(project, filename)`
Permanently removes a memory that is wrong or no longer true, along with its file. Use it only when the user wants the memory gone. To correct a memory, `save_memory` the same filename instead.

## Maintenance

### `sync`
Re-reads every memory source now and reports what changed. The server also does this on its own at startup and every few minutes, so this is rarely needed.

## Prompt

`usage_instructions` is the same guidance as the server instructions, as an MCP prompt, for apps that surface prompts but not instructions.
