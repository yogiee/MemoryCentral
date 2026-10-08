# The MemoryCentral project block

A short block in a project's instructions file does two jobs:

1. It tells **MemoryCentral** the project's name, description and stack.
2. It tells **the AI tool working in that project** to use MemoryCentral. AI tools load their instructions file into every session.

```markdown
## MemoryCentral
Project: Billing Service
Description: Invoicing and payment reconciliation for the EU storefront.
Stack: node, typescript, postgres, stripe
Use: Before a feature, fix or research task, check MemoryCentral for prior work (find_similar with a one-line task; find_by_stack per Stack tag). Save decisions, fixes and gotchas with save_memory (project "Billing Service").
```

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

All keys are optional; unknown keys are ignored. Bullets and bold are fine (`- **Stack:** node`), but the colon is required.

| Key | Effect |
|---|---|
| `Project:` | The project's name in MemoryCentral. Without it, the name comes from the repository folder. Setting it also tells apart two repositories with the same folder name. |
| `Description:` | One sentence, shown in `list_projects` and on the dashboard |
| `Stack:` | Comma-separated tags (lowercase), used by `find_by_stack` and the dashboard's grouping |
| `Use:` | Not read by MemoryCentral. It is there for the AI tool, which follows it. |

## Without a block

- **Stack:** a legacy `## Stack` section (`node, sqlite, mcp` on one line, or a bulleted list) in any of the files above still works.
- **Description:** MemoryCentral falls back to the opening paragraph of the README, then of the instructions file. A block is better: those paragraphs are often installation notes or directions to the AI rather than a description.
- **Overrides:** a stack override set on the dashboard (or in the old `~/.memorycentralrc.json` `stackOverrides`) wins over everything.

Changes are picked up on the next sync, which happens within a few minutes on its own.
