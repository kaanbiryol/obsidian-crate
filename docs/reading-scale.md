# Reading at large library sizes

Target: 50,000 Reading notes with the fewest reads and writes: no slow startup or actions in
Obsidian, and web app visits whose D1 and R2 cost does not grow with the library.

**Status.** Built: the local benchmark (step 0), the plugin list from Obsidian's frontmatter cache
(step 1), the encrypted web app loading its most recent notes (step 2), and fewer rows written
per web app edit. Chosen, not built: a [card index the plugin writes](#chosen-design-a-card-index-the-plugin-writes)
for both web apps, [offline copies only on request](#offline-copies-on-request), and
[plugin background work apart from the card list](#plugin-background-work-apart-from-the-card-list).
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
  YAML anchors). Such a hand-edited note can appear as a card; opening or editing it still runs
  the strict check and reports the problem.
- Listed highlights come from frontmatter until the note is read in the session. A marker
  deleted while Obsidian was closed still counts until then.
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
- Once the card index ships, this path is only the fallback for a vault without an index.

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

Not built. Numbers in this section are estimates until measured.

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

- **Card**: the fields the list, filters, counts, the duplicate-link check and search use:
  Reading ID, path, title, author, source URL, tags, status, favorite, saved date, highlight
  count and article state. Highlight text is kept apart in highlight shards, which the web app
  downloads only when the Highlights tab opens, the only place that searches it.
- **Shards**: cards are split into a fixed number of shards (64) by a hash of the note's
  portable path, so a note always lands in the same shard and one edit rewrites one shard. A
  rename can move a card to another shard.
- **Shard objects**: stored in R2 under the hash of their bytes, immutable. Unencrypted: gzipped
  JSON. Encrypted: sealed with the vault's Reading key, not compressed (see
  [privacy](#privacy-encrypted-vaults)).
- **Manifest**: one small R2 object per vault: format version, encryption generation, the card
  and highlight shard hashes, and `basis`, the change position the cards reflect (the Reading
  index change number for unencrypted vaults, the vault changelog `seq` for encrypted ones).
  Updated with an R2 conditional write on its ETag, so the index needs no D1 table and no
  schema change.

### Writing (plugin)

- Publishes only when the Reading folder has nothing waiting to upload and the last pull
  finished, so `basis` is a position its notes match.
- Waits until Reading changes settle, then publishes at most once a minute.
- Uploads changed shards first (named by content, so a retry is harmless), then writes the
  manifest conditionally on the ETag it read. A lost response retries the same manifest. A
  conflict means another device published: reload, recompute, retry. Shards are computed only
  from notes, so two devices converge.
- Replaced shards are deleted after a grace period (1 day), so a web app in the middle of a load
  still finds the shards its manifest names.
- Cost per publish: one manifest read and write in R2, one R2 write per changed shard, no D1
  rows. A first build is 64 card shards, the highlight shards and one manifest.

### Reading (web app)

1. Read the manifest with its ETag. Unchanged: one conditional R2 read, nothing else.
2. Download only the shards whose hash it does not have, and keep them by hash in IndexedDB.
   This is a list cache that keeps reads low, not offline content.
3. Apply the tail: changes after `basis`. Unencrypted vaults use the existing Reading change
   feed, which returns cards. Encrypted vaults read the vault changelog after `basis` for the
   Reading folder and download only the changed notes. Rows read follow changes since the last
   publish, not the library size.
4. Apply the web app's own confirmed and pending edits on top, as now.

- Tail limit: past a cap, or when `basis` is older than the change feed keeps, the app shows the
  index as it is, with "Open Obsidian to update this library", and still shows its own edits.
- No manifest (a new vault, no plugin with this version yet, or a format this app does not
  know): today's paths, step 2 for encrypted vaults and `/reading/list` for unencrypted ones.
- Search, filters, tags and counts run on the device over the whole library, on every field
  searched today. The duplicate-link check and the check that a server-sealed note does not take
  another note's name cover the whole library in both modes.

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

Today the web app stores every opened article and prefetches others in the background. Both
stop:

- Opening an article downloads it and keeps it in memory for the session only.
- **Save for offline** in the article stores that article on the device, and **Remove offline
  copy** deletes it. Saved articles are marked in the list.
- A saved copy is checked when it is opened, with one conditional request, never in the
  background. It downloads again only when its note changed.
- Removed: background prefetch (`src/pwa/reading/prefetch.ts`) and storing articles on open.
  Copies an older version stored automatically are deleted on upgrade; they were a cache.
- Unchanged: the pending-change queue, which keeps edits safe across reloads, and the card list
  cache above.

This also removes the article reads and D1 rows each prefetch cost.

## Plugin: background work apart from the card list

Not built. Today one `ReadingLibrary` does two jobs: it builds the card list at startup, whether
or not Reading is open, and it imports clips and records highlights as part of the same scan.
They split into two parts over one shared source.

### Shared source

A thin layer over Obsidian's metadata cache: the Reading folder's note paths, the cached card for
a path (validated with `validateReadingMetadata`, as in step 1), and one change stream made of
metadata cache `changed` plus vault `delete` and `rename` in the Reading folder. `changed` fires
after the cache has the new properties, so a change no longer needs to read the note to stay
current. Neither part reads notes to list them.

### Background work (always on, for sync)

- Imports clips (notes without `crate_reading_version`) and records stable IDs for highlights
  typed in Obsidian, so the web app and other devices see them without Reading being opened.
  Later, it also publishes the [card index](#chosen-design-a-card-index-the-plugin-writes).
- At startup: one pass over cached frontmatter finds clips waiting for import. No note reads,
  no card list.
- On a change: a clip is read to import it, and any other changed note is read once to check its
  highlight markers against its recorded highlights. Unchanged notes are never read.
- Waits, as now, while sync writes vault files or an editor has the note open, and retries when
  that ends.
- Keeps only what it still has to do: a queue of paths with the reason each waits (sync,
  editor). Later also the hash of each card index shard, so a change rebuilds one shard from the
  cache.

### Card list (only while Reading is used)

- Built from the cache when the Reading view opens or **Add link** needs its duplicate check.
- Keeps the sorted list, duplicate IDs, issues and the snapshot the UI renders, and follows the
  change stream only while it exists.
- Released when the last Reading view closes, after a short delay so reopening stays fast.
- Actions (favorite, status, tags, add link, delete) write the note as today; the change stream
  then updates the card.
- Imports and highlight records waiting in the background show as issues on their cards ("Close
  this note to add it to Reading.").

### What changes

- With Reading enabled, startup costs one cached-frontmatter pass for imports, not a 50,000-card
  list.
- The per-card `pending`, `deferred`, `stale` and `cached` flags, and the separate
  `refreshPaths` and `refreshProperties` paths, give way to the background queue and one change
  stream.
- The card index publisher does not depend on the UI.
- Highlight records follow every change, including edits made while Obsidian was closed, which
  the metadata cache reports after startup. The Highlights tab no longer rereads notes
  (`checkHighlights`).

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

1. Commit the work built so far.
2. Offline copies on request: remove prefetch and storing on open, add **Save for offline** and
   **Remove offline copy**, delete automatic copies on upgrade, and update
   [Reading UI](reading-ui.md) and the public docs.
3. Plugin: split [background work from the card list](#plugin-background-work-apart-from-the-card-list).
   Tests: startup with Reading closed reads no notes and builds no list; a clip imports and a
   typed highlight is recorded with Reading closed; the list appears on open and is released
   after close.
4. Card index format: cards, card and highlight shards, manifest, with frozen fixtures and a
   property test that a shard set equals one rebuilt from the same notes after random edits.
5. Worker: shard upload, manifest read and conditional write, shard cleanup after the grace
   period, and the encrypted changelog tail for the Reading folder. Rows read bounded at 10,000
   and 50,000 notes in the Worker suite; `npm run check:server-revision`.
6. Plugin: the background work builds shards from the cache, publishes when the Reading folder
   is synced and settled, and retries on conflict.
7. Web app: read the manifest, shards and tail; keep today's paths as the fallback; show the
   out-of-date notice past the tail cap.
8. Then decide whether `/reading/list` and the encrypted inventory listing can be limited to the
   fallback, and whether the unencrypted Reading index in D1 is still needed beyond the capture
   duplicate check, article jobs and the change feed.
9. Measure on a hosted D1 and R2 and on a phone with a large library.

## User-facing notes

- Documented in [Reading and encryption](reading-e2ee-assessment.md) and the public docs site's
  practical limits: with encryption, the web app shows the 10,000 most recently changed notes,
  older notes are searched in Obsidian, and it cannot detect duplicate links among older notes.
- Once the card index ships, both limits go away, and the docs say the web app's library updates
  when Obsidian syncs, so changes made while no Obsidian runs can wait.
- Offline copies on request: the web app keeps articles offline only when **Save for offline**
  is selected.

## Open questions

- Shard count (64), publish interval (once a minute), shard grace period (1 day) and tail cap.
- Whether highlight shards follow the card shards' split or have their own.
- Whether saved offline copies count against a storage limit, and how the list shows them.
