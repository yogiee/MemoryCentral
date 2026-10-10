# The project block

A short block in a project's instructions file tells MemoryCentral the project's name, description and stack:

```markdown
## Project
Name: Billing Service
Description: Invoicing and payment reconciliation for the EU storefront.
Stack: node, typescript, postgres, stripe
```

Nothing in it is specific to MemoryCentral. It describes the project to any AI tool or person who opens the repository, whether or not they run MemoryCentral, so it's never dead weight in someone else's context.

Telling the AI tool to *use* MemoryCentral isn't the block's job. MemoryCentral's server instructions do that ([usage.md](usage.md)), and they reach exactly the tools that have MemoryCentral connected.

The dashboard has a prefilled block for every project (**Settings → Project blocks**), built from what MemoryCentral already knows.

## Where it goes

Put it in the file your AI tool reads, at the repository root:

| File | Read by |
|---|---|
| `AGENTS.md` | Codex, OpenCode, and a growing number of others |
| `CLAUDE.md` | Claude Code |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `GEMINI.md` | Gemini CLI |

MemoryCentral looks in that order and uses the first block it finds. If you use several tools on one repository, put the block in each file they read. The content can be identical.

## Keys

All keys are optional; unknown keys are ignored. Bullets and bold are fine (`- **Stack:** node`), but the colon is required. A `## Project` section with none of these keys is ordinary prose and is passed over.

| Key | Effect |
|---|---|
| `Name:` | The project's name in MemoryCentral. Without it, the name comes from the repository folder. Setting it also tells apart two repositories with the same folder name. `Project:` works too. |
| `Description:` | One sentence, shown in `list_projects` and on the dashboard |
| `Stack:` | Comma-separated tags (lowercase), used by `find_by_stack` and the dashboard's grouping |

## Older forms

Still read, so nothing needs migrating in a hurry:

- **`## MemoryCentral`**, the block's name until 2026-10-10. Its `Project:`, `Description:` and `Stack:` lines work as before. Its `Use:` line is ignored and can be deleted. If a file has both headings, `## Project` wins.
- **A bare `## Stack` section** supplies the stack (see below).

## Where a project's description comes from

Highest precedence first:

1. **The block.** Plus a stack override set on the dashboard, or in the old `~/.memorycentralrc.json` `stackOverrides`; an override wins for the stack. A legacy `## Stack` section (`node, sqlite, mcp` on one line, or a bulleted list) in any of the files above still supplies the stack.
2. **An AI tool.** While working in a project that has no description, a connected AI tool can set one with `set_project_info`, and MemoryCentral's instructions ask it to. It knows the project, and it costs nothing.
3. **Automatic description** *(optional, off by default)*. Turned on in **Settings → Project descriptions**, available when Ollama is the search engine. A small local model reads the start of a project's memories and writes a description and stack tags. It re-runs only when that project's memories change. This suits apps whose memory isn't organised around repositories, such as an app with free-form chats, where no instructions file exists. Turning it on downloads the model (about 2.2 GB) after showing what it does.
4. **The README.** Failing all of the above, MemoryCentral uses the opening paragraph of the README, then of the instructions file. These are often installation notes, so treat them as a last resort.

A lower level never overwrites a higher one. The dashboard records which level each description came from.

Changes are picked up on the next sync, which happens within a few minutes on its own.
