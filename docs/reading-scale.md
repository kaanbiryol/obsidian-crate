# Reading at large library sizes

Target: 50,000 Reading notes with the fewest reads and writes: no slow startup or actions in
Obsidian, and web app visits whose D1 and R2 cost does not grow with the library.

**Status.** Built: the local benchmark (step 0), the plugin list from Obsidian's frontmatter cache
(step 1), the encrypted web app loading its most recent notes (step 2), fewer rows written per
web app edit, [offline copies only on request](#offline-copies-on-request),
[plugin background work apart from the card list](#plugin-background-work-apart-from-the-card-list),
and a [card index the plugin writes](#chosen-design-a-card-index-the-plugin-writes) for both web
apps. Not measured yet on a hosted server or a phone.
Measurements are also in [sync capacity](sync-capacity.md#reading-capacity-measurements).

## Problem

Every client built the complete Reading library locally.

| Where | Behavior before this work | At 50,000 notes |
| --- | --- | --- |
| Plugin startup | `ReadingLibrary.scan()` read and parsed every note, one at a time. Its cache was in memory, keyed by a per-session file identity, so it started empty on every launch. | 3.2 s and 50,000 reads in memory; slower on disk and on mobile |
| Plugin actions | Favorite, status, tags, add link, delete and every vault event reran the whole scan. | Every action walked, filtered, deduplicated and sorted every note |
| Plugin search | `filterReadingItems` filtered and sorted the full list on every query. | A sort of 50,000 items per keystroke |
| Web app, unencrypted | The server pages 1,000 items at a time, but the app requests every page and stores the library as one IndexedDB record that every change rewrites. | 51 requests, 16 MB and 50,460 D1 rows read per full load; capped at 100,000 items |
| Web app, encrypted | The server cannot read notes, so the app downloads and decrypts every note and rewrites its local index on each refresh. | Failed above 10,000 files or 12 MiB of metadata: the library did not load |

## Decisions

- Obsidian, desktop and mobile: everything stays on the device, including full search over
  title, author, source URL, tags and highlights. Encrypted or not makes no difference.
- Reading state (status, favorite, tags, highlights) stays in each note's frontmatter. One source
  of truth across Obsidian, the web app, file history and sync; see
  [why an edit writes rows](#why-a-web-app-edit-writes-about-18-rows).
- No migration code. When a schema change is needed, servers are deleted and created again.
- Fewest reads and writes and robustness come first. Offline use does not shape the list: the
  web app keeps an article offline only when the user saves it.
- Both web apps read the library from a card index the plugin writes. The server stores it and
  never reads it; the notes stay the source of truth.
- Not planned: server-side search (option S), a 10,000-note cap for unencrypted vaults (option
  U), per-note encrypted records, plaintext status or keyword hashes for encrypted vaults (both
  reveal note contents to the server), substring (trigram) matching, and splitting the Reading
  folder into subfolders.

## Built

### Step 0: local benchmark

`npm run benchmark:reading` runs both parts below with 50,000 notes. The ordinary suites run them
smaller: the plugin part with 2,000 notes in the unit suite, the Worker part with 10,000 and
50,000 notes in the Worker suite. Neither reads a configured server address or credentials, so
neither can reach a deployed D1 or R2.

- Plugin (`src/reading/data/library-capacity.test.ts`): a synthetic library in memory with
  Obsidian's frontmatter cache already computed. Times startup, a favorite, a status change, two
  saved links and a search, and counts note reads and full folder listings.
- Worker (`src/cloudflare/worker/reading/capacity.integration.ts`): seeds indexed notes in local
  workerd and D1 and lists them the way the web app does. Rows read come from D1's own billing
  metadata through the D1 usage header.

Reads in memory are instant, so a vault on disk, and especially on mobile, gains more than these
numbers show.

| Plugin, 50,000 notes | Before | After |
| --- | --- | --- |
| Startup | 3,186 ms, 50,000 reads | 381–484 ms, no reads |
| Favorite | 93 ms, 3 full listings | 23–66 ms, no listing |
| Status change | 84 ms, 3 full listings | 14–37 ms, no listing |
| Save a link | 117 ms, 2 full listings | first 72–131 ms, then 10 ms |
| Search | 11 ms | 12–16 ms |

### Step 1: plugin builds its list locally

`ReadingLibrary` (`src/reading/data/library.ts`) keeps one entry per note and lists the folder
once per start.

- Cards come from Obsidian's frontmatter cache through the vault adapter's `cachedProperties`
  (`src/reading/data/obsidian-vault.ts`), validated with `validateReadingMetadata`. The tags
  array is copied, because the cache's objects belong to Obsidian.
- A note is read only when it is a clip waiting for import (no `crate_reading_version`), the
  cache has not indexed it or its cached properties fail validation, it changed in this session,
  it is being opened or edited, or the Highlights tab opens and its cached properties list
  highlights.
- Vault events and actions update one entry (`refreshPaths`). A path that is not a note, such as
  a renamed folder, lists the folder again. Obsidian re-indexing a note changed while it was
  closed updates that card from the cache without a read (`refreshProperties`), except for notes
  already read in this session, whose vault events cover them.
- The sorted list and duplicate IDs are kept current per entry (binary insertion, an ID-to-paths
  map) instead of rebuilt.
- Imports and highlight records that waited for sync or an open editor retry for just those
  notes (`retryPending`).
- `filterReadingItems` checks whether its input is already sorted before sorting.
- The duplicate-link check caches each item's URL identity, so repeated saves do not normalize
  every URL again.

Tradeoffs:

- Obsidian's frontmatter parser is more lenient than `readReadingFrontmatter` (duplicate keys,
  YAML anchors). Such a hand-edited note can appear as a card until it changes: the background
  work then runs the strict check and shows the problem instead of the card. Opening or editing
  it runs the check too.
- Listed highlights come from frontmatter. The background work keeps them equal to the note's
  markers on every change; a marker deleted before this version and not changed since still
  counts.
- With an empty metadata cache, such as on a fresh install, notes are read as before, once.
- Each edit reads its note before and after writing it.

### Step 2: encrypted web app loads recent notes

- The Worker's encrypted inventory keeps its tagged-path order and page cost; each entry also
  carries `modified`, the server's time of the file's last write, which it already stores
  (`src/cloudflare/worker/encryption/encrypted-folder-files.ts`). Older web apps ignore the
  field.
- The app (`src/pwa/reading/encrypted-api.ts`) lists the whole inventory, up to 100,000 entries
  of small metadata, keeps the 10,000 most recently changed files, and downloads and opens only
  those, within the 12 MiB metadata budget. It confirms the vault sequence after opening, so the
  result is one snapshot.
- The list response carries `omitted`, stored with the library, and the app shows "Showing your
  N most recently changed notes. Search older notes in Obsidian."

Tradeoffs:

- "Most recent" is by last change, not saved date: storage keys carry no time, and the server
  cannot read saved dates in an encrypted note. An older note that was just edited counts as
  recent.
- Saving a link detects a duplicate only among opened notes. The check that a server-sealed note
  does not take another note's name also covers only those. Obsidian still checks every note.
- A refresh after any vault change lists the whole inventory: about one D1 row per Reading file.
- Ordering on the server instead would need an index on `files`, which writes one row per vault
  file when it is created and one more on every later file write. On a large vault, building it
  alone can approach the free plan's daily write allowance. Rejected.
- With the card index, this path is only the fallback for a vault without an index.

### Fewer rows written per web app edit

The Reading index writer (`readingIndexStatements` in
`src/cloudflare/worker/reading/library-index.ts`) now sets indexed columns only on rows where
they differ, and the upsert sets only unindexed columns and the change number. The library
revision changes in the same statement as the change number. On an extracted note, a web app
favorite went from 22 to 18 rows written and an archive from 19 to 15, for about 4 more rows
read. `write-cost.integration.ts` keeps those bounds; the per-save read budget in
`d1-usage.integration.ts` still holds.

Not done: skipping the article download job update on edits. The job must learn the note's new
revision, or the download fails its revision check.

## Why a web app edit writes about 18 rows

A favorite from the web app is an edit of the note's frontmatter, so it is a synced file edit.
Measured for a link still waiting for its article, before the cut above:

| Rows | What | Why |
| ---: | --- | --- |
| 5 (2 within 10 minutes of the last edit) | File version history | 30-day history; later edits coalesce |
| 3 | Changelog | Other devices pick up the edit |
| 3 | Retry receipt | A lost response and retry cannot apply the edit twice |
| 3 | Upload staging record | Cleans up the stored copy if the save fails partway |
| 1 | File row | The note's new revision |
| 6 (now about 2) | Reading index row and its indexes | Every index was rewritten, even unchanged ones |
| 2 (now 1) | Library revision and change number | Two statements, now one |
| 2 | Article download job | Only for a link still waiting for its article |

One or two rows per favorite would need Reading state stored as database flags outside the note:
Obsidian would not see them without a new sync channel, they would have no history, and retries
would still need a receipt. Rejected. Dropping the staging record for edits the Worker makes
itself would save 3 rows but needs another way to clean up a stored copy left by a failed save;
not done.

## Chosen design: a card index the plugin writes

Built. Rows in the comparison below are estimates except where the Worker suite measures them
(`card-index.integration.ts`: a tail over a 10,000-note library reads fewer than 40 rows).

### Why

Every other web app path reads something that grows with the library:

- Encrypted, as built in step 2: any vault change makes the next refresh list every Reading
  file (about one D1 row each), and a new device downloads up to 10,000 whole notes, article
  text included, to read their frontmatter.
- Option U: about 10,100 rows and 10 requests on every first load, capped at 10,000 notes.
- Option S: about 110 rows per page, 6,000 to 8,000 per common search, about 5 more rows written
  per edit, and about 550,000 rows to build. Unencrypted vaults only.

The plugin already keeps every card in memory (step 1) and holds the vault key. Writing those
cards once, as a few objects the web app downloads, makes a web app visit cost the same at 1,000
and 50,000 notes, and gives both vault modes one path.

### Shape

Format in `src/protocol/reading-index.ts` (manifest, shard number, limits) and
`src/reading/core/card-index.ts` (cards, shard bytes, sealing).

- **Card**: the note's listed item, highlights included, and in an encrypted vault its server
  path (`wire`). Highlights stay in cards: R2 bills per operation, not per byte, so separate
  highlight shards would only add writes when highlights change.
- **Shards**: 64, by an FNV-1a hash of the note's portable path, so a note always lands in the
  same shard and one edit rewrites one shard. Cards are sorted by path, so equal notes give
  equal bytes. A shard is `{ format: 1, shard, cards }` as JSON; in an encrypted vault, a
  vault-key envelope (`purpose: 'reading-index'`) whose object ID binds the shard number, key
  generation and folder generation. Not compressed (see [privacy](#privacy-encrypted-vaults)).
- **Shard objects**: `__crate__/reading-index/shards/<sha256 of the stored bytes>`, immutable.
- **Manifest**: one R2 object, `__crate__/reading-index/manifest.json`: format, folder
  generation, `basis` (the vault changelog `seq` the cards reflect) and the 64 shard hashes. An
  encrypted vault adds the key generation and `sealed`: the same fields plus each shard's
  plaintext hash, encrypted, so the server cannot point the web app at other shards or another
  basis. The Worker adds the vault's reset and import generations, which a later GET must match,
  and the replaced shards waiting to be deleted. No D1 table or schema change.

### Writing (plugin)

`ReadingIndexPublisher` (`src/reading/data/card-index-publisher.ts`), run by the background
work in `src/reading/runtime.ts`:

- Cards come from Obsidian's frontmatter cache; a note is read only when the cache has not
  indexed it. Notes not imported yet and notes the background work flagged are left out.
- Publishes when sync is idle, nothing in the Reading folder waits to upload, and Reading
  changes have been quiet for 10 seconds, so the cache has indexed what sync wrote; at most
  once a minute, the first time 30 seconds after startup. `basis` is the plugin's `lastSeq`.
- Reads the manifest, uploads only shards whose plaintext hash differs, then writes the
  manifest conditionally on the ETag it read. Encrypted envelopes are random, so equal content
  is detected from the sealed plaintext hashes. A newer manifest from another device wins
  (`behind`); a lost race (`conflict`) retries a minute later. With no card change, the manifest
  moves its basis forward only once it is 500 changes behind.
- Replaced shards are deleted by a publish a day later, so a web app reading the old manifest
  still finds them.
- Cost per publish: one manifest read and write in R2, one R2 write per changed shard, and the
  change state read (a few D1 rows). A first build writes the non-empty shards and the manifest.
- Only after the server lists `reading-index-v1` in its capabilities.

### Reading (web app)

- Unencrypted (`loadReadingFromIndex` in `src/pwa/reading/api.ts`): a first load, or one whose
  saved copy cannot be revalidated, reads the manifest, every shard and the tail. The tail
  returns the changed cards, the list ETag and the change base, so later refreshes use the
  ordinary conditional list and its delta. Without an index, or with a tail the changelog cannot
  replay, it lists every page as before.
- Encrypted (`src/pwa/reading/encrypted-card-index.ts` and `EncryptedReadingApi`): every
  refresh reads the manifest conditionally, downloads only shards it does not have, and reads
  the tail after the last position it read (the basis after a new manifest). Changed files in
  the tail are downloaded and opened; a note the server sealed may not replace or take the name
  of a listed note. Opening or editing a note reads that one file's server entry
  (`/reading/index/file`) instead of listing the folder. Shards are kept in IndexedDB by hash
  (`card-shard:`), and the manifest, position and opened changes in `card-index:`.
- A tail past 1,000 notes or older than the changelog keeps the index as it is and shows "Open
  Obsidian to update this library" among the issues. Without an index, or with one that fails
  to load or verify, both clients list the library as before (step 2 for encrypted vaults); the
  index only saves reads.
- Search, filters, tags and counts run on the device over the whole library, on every field.
  The duplicate-link check and the sealed-note check cover the whole library in both modes.

### Robustness

- Notes stay the only source of truth; the index is derived. A lost, damaged or stale index costs
  a rebuild, never data. A shard that fails its hash or decryption is ignored and reported, and
  the next publish replaces it.
- The manifest write is the only commit. A reader sees the whole old index or the whole new one.
- The format is versioned with frozen fixtures, like other stored formats. A reader that does not
  know a version uses the fallback.
- An encryption reset changes the generation, and a manifest from another generation is ignored.
- Web app edits keep their current guarantees: operation IDs, receipts and the outbox.

### Privacy (encrypted vaults)

- The server learns shard count, sizes and which shard changed when. It already sees each Reading
  file's size and write time.
- Shards are not compressed before sealing. The server can create notes (sealed captures) whose
  titles would be compressed next to private titles, and size changes could then confirm guesses
  about them.
- Belongs in the independent security review that [Reading and encryption](reading-e2ee-assessment.md)
  already lists.

### Size

The unencrypted list response measured about 325 bytes per card (16.2 MB for 50,000), so 50,000
cards are about 16 MB: about 3 to 5 MB gzipped, and about 16 MB sealed. A new device downloads that
once; afterwards a change costs other devices one shard, about 250 KB.

## Offline copies on request

Built. The web app used to store every opened article and prefetch others in the background.
Both stopped:

- Opening an article downloads it and keeps it in memory for the session only.
- **Save for offline** in the article stores that article on the device, and **Remove offline
  copy** deletes it. A save past 200 articles or 50 MB is refused; no saved copy is evicted.
- A saved copy is checked when it is opened, with one conditional request, never in the
  background. It downloads again only when its note changed.
- Removed: background prefetch (`src/pwa/reading/prefetch.ts`) and storing articles on open.
  Copies an older version stored automatically are deleted with the next library refresh
  (`commitReadingCache`); saved copies carry `offline: true`.
- Unchanged: the pending-change queue, which keeps edits safe across reloads, and the card list
  cache above.

This also removes the article reads and D1 rows each prefetch cost.

## Plugin: background work apart from the card list

Built. One `ReadingLibrary` used to do two jobs: it built the card list at startup, whether or
not Reading was open, and it imported clips and recorded highlights as part of the same scan.

### Background work (always on, for sync)

`ReadingMaintenance` (`src/reading/data/maintenance.ts`):

- Imports clips (notes without `crate_reading_version`) and records stable IDs for highlights
  typed in Obsidian, so the web app and other devices see them without Reading being opened.
  Later, it also publishes the [card index](#chosen-design-a-card-index-the-plugin-writes).
- At startup: one pass over cached frontmatter finds clips waiting for import. No note reads,
  no card list. A note the cache has not indexed yet is checked when Obsidian indexes it.
- Its input is Obsidian's metadata cache `changed` event, which fires after every change and
  after re-indexing notes changed while Obsidian was closed, plus notes renamed into the folder.
  Each such note is read once: a clip to import it, any other note to run the strict check and
  compare its highlight markers with its recorded highlights.
- `recordMarkdownHighlights` writes when a marker is new or was deleted, never when markers only
  moved, so cached properties list the highlights the note shows without a write per edit.
- Waits while sync writes vault files or an editor has the note open, and retries when sync
  state or the layout changes.
- Keeps only a queue of paths and a message per path: waiting for sync, waiting for an editor,
  or a failed strict check.

### Card list (only while Reading is used)

`ReadingLibrary` (`src/reading/data/library.ts`):

- Built from the cache when the Reading view mounts (`retain`) or an action such as **Add link**
  needs it. Until then vault events cost nothing here.
- Released 30 seconds after the last view lets go, or after an action without a view, so
  reopening Reading is instant.
- Shows the background work's messages as issues; a note it could not check or import shows
  its reason instead of a card.
- Reads a note only when the cache has not indexed it, its cached properties fail validation,
  it changed while the list exists, or an action edits it.

### What changed

- With Reading enabled and closed, startup costs one cached-frontmatter pass, not a 50,000-card
  list.
- The per-card `pending` and `deferred` flags, `retryPending`, `waitingForEditor` on the list and
  `checkHighlights` are gone. `stale`, `cached` and `refreshProperties` stay: they keep an open
  list current between a vault event and the cache update after it.
- Each edit is read twice: once by the open list, once by the background check.

## Rejected alternatives

### Option U: recent notes for unencrypted vaults

The unencrypted web app would load the 10,000 newest notes by saved date through
`/reading/list`, stopping after 10 pages, and keep them current through the change feed. No
server change, but every first load reads about 10,100 rows, older notes are out of reach, and
its main advantage, every loaded card available offline, is no longer a goal.

### Option S: indexed server search

The server would search and page the whole library from a fresh schema: stored generated
columns from `metadata_json`, partial indexes per section, a contentless FTS5 title table, tag
and count tables kept by one update trigger that changes only the difference (`EXCEPT`), pages
of 100, and at most 2,000 search matches. Rejected because every page and search reads rows,
search covers titles only, edits write more, the build takes several days of free-plan writes,
every server must be deleted and created again, and it does nothing for encrypted vaults. What
was learned while measuring it is under [techniques and findings](#techniques-and-findings).

### Comparison

| | Card index | Encrypted, step 2 | Option U | Option S |
| --- | --- | --- | --- | --- |
| What the web app reaches | Whole library | Newest 10,000 | Newest 10,000 | Whole library |
| Visit, nothing changed | 1 R2 read, no rows | about 4 rows | about 4 rows | about 4 rows |
| Visit after other changes | rows for changes since the last publish | about 1 row per Reading file | the changed notes | about 110 rows per page |
| New device | 64 shard reads, 3 to 5 MB (16 MB sealed) | every file listed, up to 10,000 notes downloaded | about 10,100 rows, 3.2 MB | about 110 rows per page |
| Search | device, every field, no rows | device, opened notes | device, loaded notes | server, titles, up to 8,000 rows |
| Writes per web app edit | as now, plus one shard write per publish | as now | as now | about 5 more |
| Build for 50,000 notes | about 65 R2 writes | none | none | about 550,000 rows |
| Server changes | shard and manifest endpoints, cleanup | built | none | new schema, servers recreated |
| Same in both modes | yes | encrypted only | unencrypted only | unencrypted only |
| While no Obsidian runs | tail from the change feed, up to a cap | current | current | current |

## Techniques and findings

All measured in local workerd and D1 unless noted. Check each against a hosted D1 database
before relying on it in a release.

- D1 counts rows read and written per statement in its result metadata; `meterD1Usage` adds them
  up without querying D1. Index entries count as written rows.
- Setting an indexed column rewrites its index entry even when the value is unchanged. Update
  indexed columns only on rows where they differ.
- Each statement in a batch re-evaluates its `WITH` inputs. Splitting one upsert into four
  statements cut writes but added about 9 rows read per save; two statements kept the read
  budget.
- FTS5 with `contentless_delete = 1` works locally and avoids storing titles twice. Matching
  rowids count as rows read.
- SQLite chose to walk a section index instead of starting from 2,000 capped search matches,
  reading 46,999 rows. A materialized match list with `CROSS JOIN` as the outer loop read 6,000
  to 8,000.
- SQLite does not guarantee the order of several triggers on the same event: an add trigger ran
  before its remove trigger and broke a primary key. Use one update trigger with each statement
  guarded by the side it reads.
- Removing and re-adding every derived row on update writes about twice as many rows as
  changing only the difference (`EXCEPT`).
- Stored generated columns from `metadata_json`, with partial indexes on them, keep writers
  unaware of derived values.
- `sqlite_version()` is not authorized in D1.
- Obsidian's frontmatter cache survives restarts and fires `metadataCache` `changed` after it
  re-indexes a note changed while Obsidian was closed. `getFileCache` has no freshness check.
- Debouncing vault events without a maximum wait starves a refresh during a long sync download;
  Reading refreshes at least every 2 seconds.
- Free plan D1 limits: 5 million rows read and 100,000 rows written a day.

## How to measure

```bash
npm run benchmark:reading
```

`src/cloudflare/worker/reading/write-cost.integration.ts` measures rows written per web app edit.
For an ad hoc query or trigger experiment, a throwaway `*.integration.ts` file under
`src/cloudflare/` runs in local workerd with `npx vitest run --config vitest.cloudflare.config.ts <file>`;
wrap `env.DB` with `meterD1Usage` and delete the file afterwards.

## Next steps

Done: committing the built work, offline copies on request, the plugin split, and the card index
(format, Worker, plugin publisher, both web apps).

1. Try both web apps and the plugin with a large library on a phone, against a test server.
2. Decide whether `/reading/list` and the encrypted inventory listing can be limited to the
   fallback, and whether the unencrypted Reading index in D1 is still needed beyond the capture
   duplicate check, article jobs and the tail.
3. Shards uploaded by a publish that then lost its race are never named, so never deleted; a
   periodic listing of the shard prefix could remove them.
4. The public docs site's Worker API reference (`docs-site/.../reference/worker-api.md`) is
   maintained apart from `docs/worker-api.md` and does not list the index routes yet.

## User-facing notes

- Documented in [Reading and encryption](reading-e2ee-assessment.md) and the public docs site's
  practical limits: with encryption, the web app shows the 10,000 most recently changed notes,
  older notes are searched in Obsidian, and it cannot detect duplicate links among older notes.
- With the card index, both limits go away once Obsidian has published it. The docs say the web
  app's library follows what Obsidian published plus later changes, and asks to open Obsidian
  when it falls too far behind.
- Offline copies on request: the web app keeps articles offline only when **Save for offline**
  is selected.

## Open questions

- Shard count (64), publish interval (once a minute), shard grace period (1 day) and tail cap
  (1,000 notes), until measured on a phone and a hosted server.
- How the list marks articles saved for offline.
