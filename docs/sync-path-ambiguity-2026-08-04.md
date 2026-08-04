# MemoryCentral — sync aborts on ambiguous encoded paths (`UNIQUE constraint failed: projects.encoded_path`)

**Filed:** 2026-08-04 · **Repo:** `~/WORK/PersonalProjects/MemoryCentral`
**Severity:** High — `sync` fails completely; every project after the failure point stops being indexed.
**Status:** ✅ **RESOLVED 2026-08-04** — commit `ed1cd05` on `main`.

---

## Resolution

Fixes 1 and 2 applied as written; Fix 3 correctly rejected. Verification plan
steps 1–6 all pass: sync ships 24 projects clean and is idempotent, `inspector`
stays on `id=14` with 59 memories (no re-parenting), `tandem-gateway` registers
as `id=29`, and `save_memory`'s lookup resolves.

Three things differed from the plan below:

- **A second decoder existed.** `export.js` had its own weaker copy that took the
  last hyphen token, mislabelling every hyphenated project (`KODI-Playground` →
  `Playground`). Manifest display names only — `import.js` restores by encoded
  path, so backups were never corrupted. The decoder now lives in
  `server/paths.js` and is shared by both callers.
- **`stats.projects++` moved after the loop body**, so a project that fails
  partway is no longer counted as synced. `stats.failed` surfaces in the stdout
  summary only; the `sync_events` table was left alone rather than migrating the
  schema for a read-time counter.
- **`resolveProject` takes an optional `home`** so tests build fixtures in a
  tmpdir instead of the real home directory.

Regression tests are in `test/paths.test.js` (`npm test` from `server/`) — the
tmpdir fixture was checked against the old greedy walk to confirm it actually
reproduces the failure rather than passing vacuously.

**Residual risk, not addressed:** fixing the decoder removed this trigger, not
the crash class. Two project directories whose *basenames* collide (e.g.
`~/WORK/foo` and `~/clients/foo`) still resolve to the same `name`, and
`ON CONFLICT(name)` merges their memories into one row silently rather than
raising. Zero collisions today; the `resolved names are unique across live
projects` test fails loudly if one appears.

---

## TL;DR

`resolveProject()` decodes Claude's dash-encoded directory names with a greedy
left-to-right filesystem walk that never checks whether the path it lands on
actually exists. When two sibling directories make an encoded name ambiguous, it
picks the wrong one, produces a bogus project name, and the subsequent upsert
violates the `UNIQUE` constraint on `projects.encoded_path` — which throws out of
the sync loop and aborts the whole run.

Fix: make the walk backtrack and only accept a segmentation that exists on disk.

---

## Symptom

```
$ sync
  ✓  ... 22 projects OK ...
Error: UNIQUE constraint failed: projects.encoded_path
    at main (file:///Users/yogi/WORK/PersonalProjects/MemoryCentral/server/sync.js:262:41) {
  code: 'ERR_SQLITE_ERROR', errcode: 2067, errstr: 'constraint failed'
}
```

Downstream, `save_memory` for an unregistered project reports:

```
Project "tandem-gateway" not found. Run the "sync" tool first to register it, then retry.
```

…which is misleading. Running `sync` is exactly what fails.

---

## Root cause

### The ambiguity

Claude Code encodes a project's absolute path by replacing `/` with `-`. Because
directory names may themselves contain `-`, decoding is ambiguous. Concretely:

```
-Users-yogi-WORK-tandem-net-inspector
```

has two syntactically valid readings:

| Reading | Exists on disk? |
|---|---|
| `~/WORK/tandem-net/inspector` | **yes** — the real project |
| `~/WORK/tandem/net-inspector` | no |

### The greedy walk (`server/sync.js:33-48`)

```js
const tokens = rel.split('-');
let current = home;
let i = 0;
while (i < tokens.length) {
  let seg = tokens[i++];
  while (!existsSync(join(current, seg)) && i < tokens.length) seg += '-' + tokens[i++];
  current = join(current, seg);          // <-- committed, never revisited
}
return { name: basename(current), path: current };   // <-- never verified
```

The inner loop extends a segment *only while the current candidate doesn't
exist*. Once a candidate exists it commits and moves on — no backtracking. The
final `current` is returned without ever confirming it exists.

### Why it started failing now

`~/WORK/tandem/` did not used to exist. With no `~/WORK/tandem` directory the
walk was **forced** to keep extending `tandem` → `tandem-net`, and landed
correctly. Creating `~/WORK/tandem/` (parent of the new `tandem-gateway` repo)
made `tandem` a valid match, so the walk now stops there and yields:

```
name: "net-inspector"   path: "/Users/yogi/WORK/tandem/net-inspector"   (does not exist)
```

**This is a latent bug in the decoder, not a problem with the new project.** Any
future `~/WORK/foo` + `~/WORK/foo-bar/` sibling pair re-triggers it.

### The crash (`server/sync.js:262` + `:161-166`)

```js
const project = stmts.upsertProject.get(name, entry.name, now);
```

```sql
INSERT INTO projects (name, encoded_path, last_synced, description, stack)
VALUES (?, ?, ?, '', '[]')
ON CONFLICT(name) DO UPDATE SET last_synced=excluded.last_synced, encoded_path=excluded.encoded_path
RETURNING *
```

Schema (both columns are `UNIQUE`):

```sql
CREATE TABLE projects (
  id           INTEGER PRIMARY KEY,
  name         TEXT    UNIQUE NOT NULL,
  encoded_path TEXT    UNIQUE NOT NULL,
  ...
);
```

The upsert now runs with `name='net-inspector'` (new) and
`encoded_path='-Users-yogi-WORK-tandem-net-inspector'` (already owned by row
`id=14, name='inspector'`). There's no `ON CONFLICT` clause for `encoded_path`,
so SQLite raises, the exception escapes the `for` loop over project directories,
and `main()` dies.

### The knock-on

Directory scan order is `readdirSync`, effectively ASCII-sorted:

```
...
-Users-yogi-WORK-TT-2026-nwestco-v4          <- last success
-Users-yogi-WORK-tandem-net-inspector        <- throws here
-Users-yogi-WORK-tandem-tandem-gateway       <- never reached
```

`tandem-gateway` sorts after `tandem-net`, so it is never registered — hence the
`save_memory` "not found". Any project sorting after the collision is collateral
damage. Two separate defects compound here:

1. **Correctness** — the decoder returns a path that doesn't exist.
2. **Resilience** — one bad project directory aborts the entire sync.

---

## Reproduction

```bash
node -e '
const {existsSync}=require("fs"),{join,basename}=require("path"),{homedir}=require("os");
function resolveProject(encoded){
  const home=homedir(), homeEnc=home.replace(/[/\\]/g,"-");
  if(!encoded.startsWith(homeEnc)) return {name:encoded.replace(/^-/,""),path:null};
  const rel=encoded.slice(homeEnc.length).replace(/^-/,"");
  if(!rel) return {name:"home",path:home};
  const tokens=rel.split("-"); let current=home,i=0;
  while(i<tokens.length){ let seg=tokens[i++];
    while(!existsSync(join(current,seg))&&i<tokens.length) seg+="-"+tokens[i++];
    current=join(current,seg); }
  return {name:basename(current),path:current};
}
console.log(resolveProject("-Users-yogi-WORK-tandem-net-inspector"));
'
```

Observed (with `~/WORK/tandem/` present):

```
{ name: 'net-inspector', path: '/Users/yogi/WORK/tandem/net-inspector' }   # path does not exist
```

Expected:

```
{ name: 'inspector', path: '/Users/yogi/WORK/tandem-net/inspector' }
```

---

## Fix 1 (primary) — backtracking `resolveProject`

Replace the greedy walk with a depth-first search that only accepts a
segmentation whose every step exists on disk.

```js
function resolveProject(encoded) {
  const home = homedir();
  const homeEnc = home.replace(/[/\\]/g, '-');
  if (!encoded.startsWith(homeEnc)) return { name: encoded.replace(/^-/, ''), path: null };
  const rel = encoded.slice(homeEnc.length).replace(/^-/, '');
  if (!rel) return { name: 'home', path: home };
  const tokens = rel.split('-');

  // Decoding is ambiguous because directory names may contain '-':
  // `-Users-yogi-WORK-tandem-net-inspector` reads as both
  // WORK/tandem-net/inspector (real) and WORK/tandem/net-inspector (not).
  // A greedy walk commits to the first existing segment and can strand itself
  // on a path that doesn't exist, so verify each step and backtrack instead.
  function walk(current, i) {
    if (i === tokens.length) return current;
    let seg = tokens[i];
    for (let j = i; j < tokens.length; j++) {
      if (j > i) seg += '-' + tokens[j];
      const next = join(current, seg);
      if (!existsSync(next)) continue;
      const found = walk(next, j + 1);
      if (found) return found;
    }
    return null;
  }

  const resolved = walk(home, 0);
  if (resolved) return { name: basename(resolved), path: resolved };

  // Nothing on disk matches — the project directory was moved or deleted, but
  // its memories are still under ~/.claude/projects. Keep the old greedy walk's
  // NAME so the existing DB row is still matched on re-sync, and return
  // path:null so meta extraction skips it instead of reading a phantom path.
  let current = home, i = 0;
  while (i < tokens.length) {
    let seg = tokens[i++];
    while (!existsSync(join(current, seg)) && i < tokens.length) seg += '-' + tokens[i++];
    current = join(current, seg);
  }
  return { name: basename(current), path: null };
}
```

Shortest-first ordering is preserved (the `for` tries the shortest segment
first), so behaviour is unchanged for every unambiguous path.

### Verified against the live tree

Ran across all 24 encoded dirs under `~/.claude/projects` that contain memories:

```
OK    inspector            <- -Users-yogi-WORK-tandem-net-inspector      # was: net-inspector (broken)
OK    tandem-gateway       <- -Users-yogi-WORK-tandem-tandem-gateway     # was: never reached
OK    LookingGlass, BenchLLAMA, AiTest, Typa, WallP, MINT, IPMSGX,
      KODI-Playground, MemoryCentral, OllamaMCP, Stardate, Trackula,
      TerminalScripts, Yamtrack-Mod, YogieeGithubIO, HAScripts,
      BondNBrick, AliceChat, LAiMA                                       # unchanged
MISS  Japan-2030, ALICE, nwestco-v4                                      # see below
unresolved: 3
```

The 3 `MISS` rows are **not a regression** — those project directories no longer
exist on disk (`~/Documents/Japan-2030`, `~/WORK/PersonalProjects/ALICE`,
`~/WORK/TT-2026/nwestco-v4` are all gone). The current greedy code also produces
a non-existent path for them; it just doesn't notice. The fallback yields the
**same name** in all three cases, so the DB rows still match. The only difference
is `path: null` instead of a phantom path, and `readClaudeMdStack()` already
guards with `existsSync(projectPath)` — so downstream behaviour is identical.

**No data repair needed.** Row `id=14` currently holds
`name='inspector', encoded_path='-Users-yogi-WORK-tandem-net-inspector'`, which
is correct. After the fix `resolveProject` returns `inspector` again and the
existing row matches on `name`.

---

## Fix 2 (resilience) — don't let one project kill the run

Independent of Fix 1: a single malformed project directory should not abort
indexing for every project after it. Wrap the per-directory body of the scan
loop (`server/sync.js:252` onward):

```js
for (const entry of readdirSync(CLAUDE_PROJ, { withFileTypes: true })) {
  ...
  try {
    const { name, path: projectPath } = resolveProject(entry.name);
    const project = stmts.upsertProject.get(name, entry.name, now);
    ...
  } catch (err) {
    process.stderr.write(`  ✗  ${entry.name}: ${err.message} — skipped\n`);
    stats.failed = (stats.failed || 0) + 1;
    continue;
  }
}
```

Surface `stats.failed` in the summary so skips are loud rather than silent.

---

## Fix 3 (NOT recommended) — a second `ON CONFLICT` clause

The tempting one-liner is to add an `encoded_path` conflict target:

```sql
ON CONFLICT(name)         DO UPDATE SET last_synced=excluded.last_synced, encoded_path=excluded.encoded_path
ON CONFLICT(encoded_path) DO UPDATE SET last_synced=excluded.last_synced, name=excluded.name
```

It parses and runs — confirmed against this project's driver (`node:sqlite`,
SQLite 3.53.4) — but **do not apply it on its own.** Tested behaviour:

```
row1: {"id":1,"name":"inspector",     "encoded_path":"-enc-a"}
row2: {"id":1,"name":"net-inspector", "encoded_path":"-enc-a"}   # silently renamed
```

Against the real bug this would have quietly renamed `inspector` →
`net-inspector` and re-parented its 59 memories, instead of crashing. The crash
was the safer failure. Only consider this *after* Fix 1, and even then the
rename semantics need deciding deliberately. Note also that it does not cover
the case where `name` matches row A while `encoded_path` matches a different
row B — SQLite resolves only the first conflict, and the second still raises.

---

## Verification plan

1. Apply Fix 1 (and ideally Fix 2).
2. `sync` → expect 24 projects, no error, `inspector` still named `inspector`.
3. `sqlite3 stats/knowledge.db "SELECT id,name,encoded_path FROM projects WHERE encoded_path LIKE '%tandem%';"`
   → expect two rows: `inspector` and `tandem-gateway`, each with the correct
   encoded path, and `inspector` still on `id=14`.
4. `sqlite3 stats/knowledge.db "SELECT COUNT(*) FROM memories WHERE project_id=14;"`
   → expect 59, unchanged (proves no re-parenting).
5. `list_projects` → 24 entries including `tandem-gateway`.
6. `save_memory({project:"tandem-gateway", ...})` → succeeds.

## Regression guard worth adding

A unit test asserting `resolveProject()` returns an existing path for every
directory under `~/.claude/projects` that has memories, plus a synthetic
fixture pair (`tmp/foo/` and `tmp/foo-bar/baz/`) covering the ambiguity
directly — that's the case that silently rotted here.
