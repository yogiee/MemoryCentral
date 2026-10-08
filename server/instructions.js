// What every connected AI tool is told about MemoryCentral.
//
// INSTRUCTIONS is sent as the MCP server's `instructions` at initialize. Clients
// differ in how much they keep: Codex reads the first 512 characters as the
// summary, Claude Code truncates at 2,048. So the first paragraph must stand on
// its own, and the whole text stays under 2,048. Tool names are bare because
// every client prefixes them differently (mcp__memoryCentral__…, memoryCentral.…).

export const INSTRUCTIONS = `\
MemoryCentral is the user's cross-project memory: decisions, fixes and gotchas from every project and every AI tool they use. \
Before implementing a feature, fixing a bug or researching, call find_similar with a one-line description of the task (and \
find_by_stack for the project's stack tags) to reuse prior work; verify a hit still applies before using it. When you settle a \
decision, fix a non-obvious bug or learn a gotcha, record it with save_memory.

Tools:
- find_similar(description): semantic search across all projects. Best for "how did we handle X".
- search_memories(query, project?): keyword search for named things (a library, an error message, a tool).
- find_by_stack(tag): projects using a technology, e.g. node, swift, python.
- list_projects / get_project_summary(project) / get_project_memories(project): browse.
- save_memory(project, filename, content, project_path?): create or update a memory. Re-saving a filename updates it in place.
- delete_memory(project, filename): only when the user wants a wrong or stale memory gone.
- set_project_info(project, description, stack): if the project you are working in shows no description, set one.

Conventions:
- Project name: the "Project:" line of the repository's "## MemoryCentral" block (in AGENTS.md, CLAUDE.md, \
.github/copilot-instructions.md or GEMINI.md) if it has one, otherwise the repository folder name. Pass project_path when you know it.
- One memory per file, a descriptive snake_case filename ending in .md, and frontmatter with name, description and type \
(feedback | project | user | reference).
- Save what a future session could not rederive from the code or git history: the why behind a decision, a fix's root cause, \
an external constraint. Not routine changes.
- If a search finds nothing relevant, carry on without mentioning it.`;

// The same guidance as a prompt, for clients that surface MCP prompts but not
// server instructions.
export const USAGE_PROMPT = `## MemoryCentral — cross-project memory\n\n${INSTRUCTIONS}`;
