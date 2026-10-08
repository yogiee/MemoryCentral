# Storage and retention

## Where memories live

Every memory is a Markdown file. There are three kinds of place a file can live:

| Source | Folder | Who writes there |
|---|---|---|
| **Claude Code** | `~/.claude/projects/<encoded repo path>/memory/` | Claude Code's own memory system, and `save_memory` when it updates a memory already there |
| **MemoryCentral** | `~/.memorycentral/projects/<project>/memory/` | `save_memory` for anything new; this is where memories from Copilot, Codex, OpenCode and other tools end up |
| **Registered folders** | Anywhere you choose (e.g. a repo's `memory-bank/`) | You, or whatever tool keeps notes there |

MemoryCentral reads the first and third kinds **in place**. It never copies them. Their full content is indexed, so every memory is searchable, and whatever those tools write later keeps flowing in.

A memory is identified by its project and its filename. Saving `notes.md` for a project:

- updates the existing `notes.md` wherever it lives;
- otherwise writes to a project folder that already has a `notes.md` on disk;
- otherwise creates it in MemoryCentral's own store.

So the same memory saved from two tools never becomes two copies.

## When a memory is removed

MemoryCentral's rule is that **knowledge is retained unless you deliberately remove it.**

| What happened | What MemoryCentral does |
|---|---|
| You call `delete_memory`, or delete it on the dashboard | Removes the file and the memory. Deliberate, so immediate. |
| One file is deleted from a folder that otherwise reads fine | Removed from search at once, then **kept for 30 days** under *Recently deleted* on the Settings page, where you can restore it |
| The same file comes back | It's back in search, and its tombstone is cleared |
| A file is renamed, with the same content | The memory is renamed in place. No re-indexing. |
| **More than 5 files and more than 30 % of a folder disappear at once** | **Nothing is removed.** The folder is marked *Held* on the Settings page until you confirm the removals. Files that reappear before then simply stay. |
| A folder can't be read (permissions, a disconnected drive, a sync tool mid-way) | **Nothing is removed.** The folder is marked *Unreadable* and checked again on the next sync. |
| A whole folder disappears (repo deleted, Claude Code uninstalled) | **Nothing is removed.** The memories stay searchable and in backups; the folder is marked *Folder gone*. *Keep in MemoryCentral* on the Settings page copies them into MemoryCentral's store as files. |

Tombstones older than 30 days are purged on the next sync.

## Backups

```bash
node export.js                 # → memoryCentral-backup-YYYY-MM-DD.json.gz
node import.js <backup-file>
```

A backup contains every memory from every source. That includes memories whose source folder is gone, which exist nowhere else. It also holds projects, registered folders, recently deleted memories and portable settings.

Restoring puts each file back in its original folder if that exists on this machine, otherwise into MemoryCentral's store, so nothing in the backup is lost on a machine with a different layout. A file already present is kept, since it is that machine's current version. Backups from older versions, which held only Claude Code folders, still import.

## What's on disk

```
~/.memorycentral/
  memorycentral.db      the index (rebuildable from the files + a backup)
  projects/             memories MemoryCentral owns
  models/               built-in embedding models
  generated/            DASHBOARD.md and snapshots
```

To move to a new machine, run `node export.js` on the old one and `node import.js` on the new one after `node setup.js`. To start completely fresh, stop every AI tool and the dashboard, then delete `~/.memorycentral/`. Your AI tools' own memory folders are never touched by that.
