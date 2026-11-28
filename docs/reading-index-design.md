# Reading index: cost proportional to change

Target: every Reading action in the web app and the Worker costs D1 rows in proportion to what
changed, never to the library size. Builds on [Reading library and search on the server](reading-search.md);
the plugin is unchanged.

**Status.** Built, in the order of the sections below; measured in local workerd and D1, not
yet on a hosted server. The app is not released, so the schema changed in place: no migration
code, existing development servers are deleted and created again.

## Measured problem

Local workerd and D1, 10,000 Reading notes with 2 tags each (scaled to 50,000 where it grows).

| Action | Rows | At 50,000 notes |
| --- | ---: | ---: |
| Tag list for one section, read (even Favorites with 20 notes) | 40,006 | about 200,000 |
| Web app visit with 4 dock sections (pages and tags), read | about 160,000 | about 800,000 |
| Web app refresh 1,000 rows deep: pages, then tags, read | 1,101 + 40,104 | about 1,100 + 200,000 |
| Move a Reading note inside the folder (also each retitle after a download), written | 39 | 39 |
| Full index rebuild, written per note (wipe, then index again) | 27 | 1.35 million in all |

Free plan limits: 5 million rows read and 100,000 rows written a day. A rebuild of 50,000 notes
spends 13 days of writes in one go, after which every vault write fails until the next day.

## Design

### 1. Derived rows keyed by the note's row, not its path

- `reading_items.id` (the rowid) is the note's key for every derived row: `note_terms(term,
  saved_at, item)`, `highlight_index(highlighted_at, item)`, and the section indexes end in `id`
  instead of `portable_path`. `portable_path` stays unique on `reading_items` only, to find a
  note by its path.
- A move commits the source removal and the destination in one batch. When the destination has
  no row and the removed row has the same Reading ID, the writer moves that row to the new path
  (one row and its path index). Terms, highlights and counts stay. The usual diff then applies
  whatever else changed.
- List and search cursors become `(saved_at, id)`, opaque to clients as before.

### 2. Rebuild reconciles instead of wiping

- A rebuild with the same folder and generation (a restore, a commit whose bytes the writer
  could not see, a new index format) keeps every row. Each step walks 25 files in path order and
  reads a note from R2 only when its row does not name the file's current revision; the same
  step removes rows whose file is gone. Unchanged notes cost one row read and no write.
- A new folder or generation still starts empty: those are other notes.
- Steps stop for the UTC day once they have written `READING_REBUILD_DAILY_ROWS` (50,000) rows,
  counted from D1's own metadata in `reading_policy`, and continue the next day. A first import
  of N notes takes about `N * 15 / 50,000` days; the web app answers 503 with progress meanwhile,
  as today.

### 3. Stored tag counts per section

- `reading_tag_counts(section, term, count)`, one row per section and tag. Sections: inbox,
  archived, favorites, highlights, with the same membership rules as the list filters (visible,
  not a duplicate).
- `reading_items.tag_terms` lists a note's tag terms (`t:` terms, or an encrypted note's hashed
  tag terms from its card).
- The commit batch adds the difference between each written note's new and old contributions,
  only where it is not zero. A title edit writes no count; a favorite writes one count row per
  tag; an archive writes two. A duplicate flag that flips adjusts the counts of that note.
- Duplicate flags are recounted only for the Reading IDs a commit writes and the IDs its rows
  leave (read before the rows change), not for every flagged row.
- `/reading/tags?section=` reads that section's count rows: one row per tag, at any size.

### 4. Library revision and change feed

- Every batch that changes Reading rows also sets `reading_policy.changed` to its commit's
  changelog sequence (one row written, on Reading commits only). A rebuild step bumps
  `reading_policy.epoch`.
- `GET /reading/items` returns `revision` (`epoch:changed`) and honors `If-None-Match` with it:
  an unchanged library answers 304 after reading one row.
- `GET /reading/changes?since=<revision>` lists what changed: the changelog entries after the
  sequence, up to 500, kept to the Reading folder, and the current rows for those paths and their
  Reading IDs (listed or removed). Past 500 entries, or another epoch, it answers `reset`.
- The web app keeps its loaded pages and applies changes in place: a changed note leaves its
  old place and goes where it now sorts if that is inside the loaded range; a removed or hidden
  note leaves. Searches and tag filters are read again, as now. On `reset` it reloads the first
  page, as now. The 20-page reload goes away.

## Cost after

Measured locally where noted; the integration tests keep the bounds.

| Action | Before | After |
| --- | ---: | ---: |
| Tag list for one section, read | 40,006 (200,000 at 50k) | about 2 per tag in the section, measured under 250 for 100 tags at 10,000 and 50,000 notes |
| Web app visit, 4 dock sections, read | about 160,000 | about 650, estimated |
| Refresh with no change, read | 41,205 | under 10, measured |
| Refresh after k changed notes, read | 41,205 | under 40 for a few notes, measured |
| First page or search page, read | unchanged | unchanged |
| Move inside the folder, written | 39 | 16, measured (10 of them the file move) |
| New Reading note, written | 21 | about 24 (tag counts, revision) |
| Favorite, read | 127 | 146, measured: the tag count difference and the new row's own statements |
| Favorite or archive, written | about 15 | about 16 to 19 |
| Rebuild of unchanged notes, written | 27 per note | 2 in all for 30 notes (the position and budget), measured |
| Rebuild, R2 reads | 1 per note | 1 per changed note |
| First import or new folder, written | 27 per note, all at once | about 15 per note, at most 50,000 a day |

Reads grew a little per edit to keep writes down: the free plan allows 50 times more reads than
writes a day.

## Found along the way

- A new folder without files used to mark the index complete while rows of the previous folder
  stayed listed. The policy update now starts a rebuild that removes them.
- A restore now resets every derived Reading table with `reading_items`, so a rebuild never
  keeps terms or counts of rows it does not have.

R2 is untouched by lists, search and tags before and after; an edit is still one R2 write and an
opened article one R2 read. Durable Object use is unchanged.

## Measured at scale

Local workerd and D1, rows from D1's own metadata, through the real routes (the web app's
requests include authentication and the coordinator hop). Seeded libraries: 100 tags, every
tenth note a favorite.

| Action | Read, 10,000 notes | Read, 50,000 notes | Written |
| --- | ---: | ---: | ---: |
| First inbox page / next page | 57 / 55 | 57 / 55 | 1 / 0 |
| Search, a word every note has (page 1 / page 2) | 104 / 105 | 104 / 105 | 0 |
| Search, a rare word | 39 | 339 | 0 |
| Search, a rare word beside a common one | 112 | 1,162 | 0 |
| Tag filter page | 104 | 104 | 0 |
| Tag list, inbox (100 tags) / favorites | 204 / 25 | 204 / 25 | 0 |
| Open an article | 5 | 5 | 0 |
| Refresh, nothing changed / after one edit | 4 / 14 | 4 / 14 | 0 |
| Favorite / archive / tag edit (web app) | 163 / 163 / 203 | 163 / 163 / 203 | 16 / 13 / 13 |
| First highlight (web app) | 184 | 184 | 13 |
| Save a link (web app) | 139 | 139 | 17 |
| New note, move, delete (sync) | 120 / 283 / 196 | 120 / 283 / 196 | 16 / 14 / 21 |
| Rebuild of an unchanged library, all steps | 26,327 | 134,395 | 54 / 268 |

The rebuild measurement found that each files step read every file before its cursor again
(96,327 and 1,817,895 rows); the cursor is now the walk's lower bound. A rare word's cost follows
how many notes share its first three letters, not the library.

## Smaller fixes

Found in the same review; each grew with the library, the scroll depth or the article.

- Worker: a search's term counts read at most about 2,000 rows (they could reach 5,500) and only
  on its first page. Every list page, not only Highlights, ends before 512 KB. The duplicate
  recount reads the groups a commit touches: an unrelated edit read 3,522 more rows with 40
  flagged copies, and now reads the same as with none.
- Web app: saved-link rows are memoized, so an update re-renders only changed rows; Highlights
  rows skip layout and paint off screen (`content-visibility`; on saved-link rows it moved text
  by a fraction of a pixel and a restored scroll position by one, so they keep their layout); the
  Highlights rows are sorted once per loaded list instead of on each keystroke or edit; a page's
  encrypted cards open in parallel and no per-session map of listed notes grows; image object
  URLs are released once no view shows them (the last 60, up to 40 MiB in all, stay for reuse) and an abandoned image
  download is cancelled; a search typed past is cancelled.
- Plugin: the filename check walks only the folders on the new path instead of every vault file;
  `create` events are heard only after the layout is ready, past Obsidian's startup burst; a
  library update builds no search text without a search, and sorts no highlights outside the
  Highlights section; background work skips notes already waiting for sync on each refresh
  (500 lookups for 50 notes over 10 refreshes, now none).
- Both: saving a highlight on an 800 KB article took 867 ms and takes 519 ms. The Markdown parser
  searched the rest of the note for a math block at every paragraph; it now stops at the
  paragraph's end, which is all the parser uses. The rest of the time grows with the article.
- Left as is: the queue limit checks count the extraction queue (at most 1,000 rows), only when a
  commit queues a fetch. A stored count would cost writes, which the free plan allows 50 times
  fewer of.

## Not changed

- Reading state stays in each note's frontmatter, so a web app edit is a synced file edit. About
  15 of a favorite's rows are file history, changelog, retry receipts and the upload staging
  record; that is sync's design and is reviewed separately.
- Search terms, the term walk caps and the Highlights scan caps.
- The plugin's own library model: it reads its vault, not the Worker.

## Tests

- `write-cost.integration.ts`: rows written by a favorite, archive, highlight, move and new note.
- `capacity.integration.ts`: the tag list and an unchanged refresh at 10,000 and 50,000 notes.
- A tag count test that compares `reading_tag_counts` with counts from the rows after creates,
  tag edits, favorites, archives, highlights, duplicates, moves and deletes.
- Reconcile: a rebuild of an unchanged library writes no rows and reads no R2 objects; a changed
  or missing note is indexed again or removed; the daily budget stops and resumes.
- PWA: changes applied to loaded pages keep order and remove notes that left the section;
  `reset` and 304 paths.
