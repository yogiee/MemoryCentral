# Using MemoryCentral as an Active Knowledge Base

MemoryCentral does two distinct jobs:

1. **Passive** — harvests memory files from every Claude session and makes them searchable via a dashboard and MCP tools.
2. **Active** — surfaces prior solutions, architectural decisions, and hard-won feedback from *other* projects while you're working, before you spend time re-searching or re-solving something you've already figured out.

The passive job works out of the box. The active job requires one small convention per project. This document explains that convention.

---

## The Problem It Solves

Claude's context is session-scoped. Every new project starts from scratch. If you solved a tricky SwiftData migration issue in `App_A` six months ago, Claude working on `App_B` today has no idea — it will either search the web, hallucinate an approach, or ask you to figure it out again.

MemoryCentral breaks that wall. But Claude needs to know *when* to look and *what* stack to search for. That's what the `## Stack` convention provides.

---

## Setup: Two Things to Do

### 1. Add a Stack block to each project's CLAUDE.md

Open (or create) `CLAUDE.md` at the root of your project and add this section anywhere in the file:

```markdown
## Stack
swift, uikit, swiftdata
```

Use lowercase, comma-separated tags. Match the tags MemoryCentral uses — run `memoryCentral:list_projects` in any session to see the tags already in your database, or pick from the common tags below.

**Common stack tags**

| Language / Runtime | Framework / Platform | Data / Infra |
|--------------------|----------------------|--------------|
| `swift` | `swiftui` | `sqlite` |
| `python` | `uikit` | `postgres` |
| `typescript` | `react` | `redis` |
| `javascript` | `nextjs` | `supabase` |
| `node` | `express` | `firebase` |
| `go` | `fastapi` | `snowflake` |
| `rust` | `django` | `s3` |
| `kotlin` | `vapor` | `docker` |
| `java` | `electron` | `kubernetes` |

You can use as many tags as are accurate. `swift, swiftui, swiftdata, sqlite` is fine.

---

### 2. Add the lookup rule to your global CLAUDE.md

The `## Stack` block is just a signal — it only works if your global `~/.claude/CLAUDE.md` tells Claude to act on it. If you installed MemoryCentral with `node setup.js`, this rule was added for you. If you set up manually, add the following section to `~/.claude/CLAUDE.md`:

```markdown
## MemoryCentral — Cross-Project Knowledge Bank

All local Claude projects are indexed in a central SQLite DB with FTS and semantic search.
MCP server: `memoryCentral` (available in every session).

### Stack-aware lookup — always do this first

If this project's CLAUDE.md contains a `## Stack` block (e.g. `swift, uikit, swiftdata`),
**before implementing any feature, solving any bug, or starting any research**, call:

1. `memoryCentral:find_by_stack(<tag>)` — once per tag listed in the Stack block
2. `memoryCentral:find_similar(<one-line task description>)` — describe what you're about to do

Run these **before** opening Context7 or doing any web search. If a result surfaces a prior
solution, verify it's still valid (check the file exists, grep for the symbol), then apply it.

### General triggers (no Stack block required)

- "How did we do X before?" → `find_similar`
- Implementing auth, networking, scroll, caching, navigation, persistence → `search_memories` + `find_similar`
- Starting a library integration likely used in another project → `find_by_stack`

### Write memories via MCP

When you save an important memory (feedback, architectural decision, key discovery), also call
`memoryCentral:save_memory` so it's immediately searchable — don't wait for the next sync.

    memoryCentral:save_memory({
      project:  "ExactProjectName",
      filename: "feedback_auth.md",
      content:  "---\nname: ...\n---\n\n..."
    })
```

---

## What Happens After Setup

When Claude starts a task in a project with a `## Stack` block, it will:

1. Call `find_by_stack` for each tag — returns all projects sharing that stack, with their memories
2. Call `find_similar` with a description of the task — semantic search across all projects
3. If relevant memories are found, verify they're still accurate, then use them
4. Only if nothing useful surfaces does it proceed to Context7 or web search

You don't have to ask. It happens automatically on every implementation task.

---

## Writing Memories That Travel Well

A memory is only useful cross-project if it's written at the right level of abstraction. Some guidelines:

**Write memories about the *why*, not the *what*.** The code itself is in the repo. A memory that says "use `@MainActor` on the view model" is marginally useful. One that says "SwiftUI previews silently fail when the view model isn't `@MainActor` — no error, just a blank canvas; always annotate" is the kind of thing that saves 45 minutes in a new project.

**Include the constraint or surprise.** The most valuable memories are the ones where the obvious approach doesn't work. Document what you tried, why it failed, and what actually worked.

**Use the standard memory format.** MemoryCentral's FTS and semantic search index the `name`, `description`, and body. A well-structured memory surfaces more reliably.

```markdown
---
name: swiftdata-migration-add-column
description: How to add a non-optional column to an existing SwiftData model without wiping the store
metadata:
  type: feedback
---

Add a `VersionedSchema` and `SchemaMigrationPlan` even for trivial column additions.
SwiftData will crash with a cryptic schema mismatch error if you add a non-optional
property to a live model without declaring a migration — it doesn't auto-migrate defaults.

**Why:** Hit this in App_A when adding `createdAt: Date` to `Item`. Store wiped on first launch.
**How to apply:** Any time a SwiftData model gains a new non-optional property.
```

---

## Checking What's in the Bank

Run in any Claude session:

```
memoryCentral:list_projects          → all projects + stack tags + memory counts
memoryCentral:find_by_stack("swift") → all swift projects and their memories
memoryCentral:search_memories("auth")→ every memory mentioning auth, all projects
```

Or open the dashboard at `http://localhost:9980` for a visual browse.

---

## Keeping It Current

- Memories are written during sessions by Claude (via the auto-memory system)
- MemoryCentral syncs them after each session via the Stop hook
- To force a sync: `node sync.js` or click Sync in the dashboard
- To write a memory mid-session without waiting for the stop hook: use `memoryCentral:save_memory`

The knowledge base only gets better as you work. Every important decision Claude captures in a session becomes available to every future project on the same stack.
