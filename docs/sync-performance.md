# Initial upload performance

An empty, never-populated remote uses the resumable initial import capability
`resumable-initial-import-v1` (protocol 1). The first device uploads the vault,
completes its initial sync, and then additional devices download that vault.

Initial imports store file contents in R2 and current file metadata in D1. They
skip per-file upload receipts, changelog entries, retained versions, and reminder
processing. One upload lease per request covers up to 32 immutable object keys;
publication and cleanup remain transactional. Three client requests stay in flight:
each starts the next prepared batch as soon as its previous one finishes, rather
than waiting for a group of three. Preparation stays within the byte budget, and the
local manifest is saved every 256 confirmed files or 5 seconds and when the import
ends. Large attachments use binary requests. The Worker writes a batch's objects to
R2 through a rolling pool of 4. The decoded bodies are already in memory, so the
pool adds no memory or CPU, and it stays below the limit of 6 simultaneous
outgoing connections.

Committed remote path/hash/size metadata is the resume checkpoint. After a
connection failure or restart, the client compares local bytes with that inventory,
skips matching files, uploads missing or changed files, and removes files deleted
locally during the pause. There is no expiry on committed import progress.

Upload completion verifies the inventory checksum and records one sync baseline.
The client then shows “Preparing reminder schedules” until the selected folder has
been verified and projected; projection writes each schedule in the same commit. A durable
marker resumes this phase after a restart without uploading unchanged files.
Reminder errors keep setup incomplete and are surfaced to the user; reminders
already overdue when first indexed do not receive catch-up notifications. Later
syncs use the normal change history and recovery receipts. Late import requests
cannot change a completed vault. Existing vaults use the normal upload path.

An encrypted vault uses the import too: for its first sync, and right after the
reset that turns encryption on, which leaves the server empty. The device sends
ciphertext under server paths, and the Worker validates each batch as it validates
a normal encrypted upload, stores each file's descriptor in its `files` row, and
publishes only while the vault keys the request was made with are active and no
reset has started since. Resuming compares the plaintext of the descriptors the
manifest lists, and completion verifies the server's ciphertext hashes and sizes.
Reminder readiness parses schedules from each encrypted reminder note's public data,
and the Reading index takes each note's card from it.

Reminder settings retry in the background during established file syncs and periodic
checks; a failed or slow settings request does not block file transfers. First-time
imports require the selected folder to reach the server before sealing the import,
and unfinished reminder setup retries it before waiting for schedules. If this
request fails, already uploaded files remain available to resume without reuploading.
Successful settings confirmations are cached in memory for the current connection
and policy inputs. Unchanged syncs and periodic checks send no further policy
requests. Relevant settings changes, pending folder edits, reconnecting, or restarting
the plugin require a fresh confirmation; failed requests remain eligible for retry.

## Initial upload write budget

The local workerd/D1 billing-metadata regression measures **10,946 row writes for
10,000 ordinary notes**, including import setup and paged completion with 32-file batches.
Eight-file batches cost 13,757 writes. An import of about 50,000 files therefore fits
one day of the Free plan's 100,000 row writes. Replaying a committed batch writes zero rows
and uploads no R2 objects. The same statements serve an encrypted import.

| Component, for 10,000 ordinary notes | Measured row writes | Purpose |
| --- | ---: | --- |
| Current file records | 10,000 | One row each: identity, original spelling, content hash, size and object pointer |
| Upload leases | 626 | 313 requests, each with an insert and lease removal |
| Import generation checkpoints | 313 | Fence completion against batches still in flight |
| Session and completion | 7 | Open the import and publish its sync baseline |
| Total | 10,946 | No per-note history, upload receipts or reminder indexing |

Setting up reminder schedules after the import writes about 8 rows per scheduled reminder
(projection, source and occurrence rows with their indexes). On a Cloudflare server the
coordinator pauses that bulk source scan once notification passes have written 40,000 rows
in a UTC day (`SOURCE_SCAN_DAILY_WRITE_BUDGET`) and resumes after 00:00 UTC, so a large
first sync and its schedules do not exhaust the day's allowance. Projection of edited notes
continues past the budget, so edits keep notifying.

### Whole first sync, reads and writes

A first sync through the production sync engine and the local Worker, summing each
response's `X-Crate-D1-Usage`, measures these costs. The runs covered 2,000 and 4,000
notes of about 1.6 KB and 30 files of 2 MiB, in plaintext and encrypted vaults, with no
reminder folder. Encrypted runs measured within 1% of plaintext ones.

| Per item | Rows read | Rows written | Requests |
| --- | ---: | ---: | ---: |
| Note, in 32-file batches | about 24 | 1.09 | 1 per 32 notes |
| File of 1 MiB or more, sent alone | 34 | 4 | 1 |
| Fixed per first sync | about 80 | 7 | 8 |

Reads grow linearly with the vault. The import handler reads 20.4 rows per note in
32-file batches (`initial-import.integration.ts`), down from 51.4: the upload lease
guard now matches its key as text and a fully settled lease is removed by counting its
keys, instead of walking them with `json_each`. The note row above adds the engine's own
requests and was estimated from that change, not measured again end to end.

For a vault of 50,000 notes and 5 GB of PDFs (2,500 of 2 MB) this projects to about
65,000 row writes, 1.3 million row reads and 4,100 Worker requests, plus as many
transfer Durable Object requests. That is about 65% of the Free plan's daily writes and
26% of its reads. The most expensive 5 GB, about 5,000 to 6,500 files just over the
batch limit, projects to about 82,000 writes and 1.5 million reads. An encrypted file
is sent alone from about 750 KB of plaintext, since its ciphertext is larger.

Storage for that vault: D1 holds about 30 MB in plaintext and about 60 MB encrypted. R2
holds about the vault's size in plaintext. Encrypted objects are base64url JWE with a
JSON header, about a third larger plus about 1 KB per file, so 5.2 GB becomes about
7 GB of R2's 10 GB monthly allowance. Retained versions add to both.

When a reminder policy is configured, tracking and acknowledging initial reminder
readiness adds **two row writes per vault**, independent of note count, in addition
to the selected-folder scan and actual reminder processing. Pending readiness
probes write zero rows and use bounded indexed reads. Projection writes each schedule into its `reminder_projections` row, and a coordinator
pass that wrote one sends one internal request to the dispatcher role of the existing
Durable Object class; it adds no extra D1 records.

`files` is a `WITHOUT ROWID` table keyed by the normalized portable path. The
original path remains metadata and is checked on exact-path reads and writes.
This preserves spelling, case/Unicode collision protection and file/folder guards.
Each new file writes one row. A page keeps at most about 1 KB of such a row, and a
larger row takes an overflow page of its own, which measures 4,691 bytes per row. Two
choices keep an encrypted file's row small. A descriptor's
private metadata is one binary envelope: about 400 to 530 characters of JSON for a
note. The Worker stores each descriptor packed, with
its IDs as 16 bytes each, about 280 to 410 characters, and rebuilds the exact JSON on
read; a descriptor that would not rebuild exactly is stored as its JSON. Measured on
disk, an encrypted note's row takes 692 to 1,207 bytes up to seven folders deep, and a
deeper note's row still takes an overflow page. A rowid table with a unique portable-path key would avoid overflow
pages but write a second row for every new file, which would push a 50,000-file first
sync past one day's row writes. `file_versions` (unique
`storage_key`) and `reading_items` (unique `portable_path`) are rowid tables, since
an import writes neither and an edit's kept version is written once. Manifest pages follow portable-key order
and still return original names and original-name continuation cursors. An empty, never-imported vault remains eligible for the cheap initial-import path.

Lease and cleanup records carry the owning file path. Current-object checks use
the portable-path key and immutable object revision; retained-object checks use the
version's unique storage key. There is no current-file storage-key index.
Immutable keys are never
transferred to another file or reused by a restore.

The per-file inventory writes are the main cost. Cutting the remaining 947
writes would require larger batches or replacing durable leases and completion
fencing, which protect interrupted uploads and late requests.

Larger batches retain the 10 MiB decoded payload limit, bounded R2 concurrency,
conditional file writes, and resumable cleanup. Regression tests include byte-based
splitting, successful and rejected 32-file requests within 45 D1 queries,
and selected-folder reads that remain bounded with 10,000 unrelated notes. Removing
the Markdown index means attachments inside the selected folder also participate in
its metadata scan; file content is still read only for Markdown. Files outside that
folder are skipped by the portable primary key.

This measurement uses the schema-1 baseline: `WITHOUT ROWID` for `files`, upload
receipts, upload leases, reminder verification and projection jobs, and rowid
`file_versions` and `reading_items` tables with unique keys. These
figures exclude device setup, actual reminder indexing, failures and cleanup, and
other activity sharing the account's daily quota. They do not guarantee that every
10,000-file vault consumes the same allowance.

Reminder indexing runs after import and only reads Markdown inside the selected
folder and its subfolders. Notes elsewhere receive no reminder source records,
parsing, quarantine, or notification work. Changing the selected folder retires
old source records and cancels old projections without reading those files.

Run the initial-import regression with:

```sh
npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/sync/import/initial-import.integration.ts --reporter=verbose
```

The normal 32-file upload path retains per-file receipts and changelog entries.
Its separate 8,000-note benchmark, with notes inside the selected reminder folder,
measures 48,500 row writes on a new database. This is a regression check for normal
uploads, not the cost of an initial import.

## Rename write cost

A plaintext rename of unchanged bytes is a server move (`POST /sync/batch-move`). For 32
files, `sync/batch-move.integration.ts` measures 129 D1 row writes for the move and 32 more
when maintenance prunes its log row, against 292 for the same renames sent as uploads and
deletes and 33 more when their retained copies expire. The move writes no R2 object. That is
about 4 rows per file at the move instead of 9: moving a folder of 10,000 notes writes about
40,000 rows of the Free plan's daily 100,000 instead of about 91,000, and the moved files keep a
single stored copy instead of a second one retained for the history period. A day holds
about 20,000 moved files after normal use; a larger folder finishes after the daily reset at
00:00 UTC. Encrypted vaults, reminder and Reading notes, and edited files still upload and
delete.

## Normal upload benchmark

The bulk new-file benchmark uploads 8,000 distinct Markdown notes of about 1 KiB
through the batch handler with real local workerd/D1/R2. Its timings exclude internet
latency, Obsidian disk work, authentication and Durable Object forwarding, so they
are not predictions of hosted completion times.

Run the benchmark with:

```sh
npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/sync/staging/bulk-new-upload-benchmark.integration.ts --reporter=verbose
```

Recovery tests cover response loss, interrupted R2 staging, failed transactions,
concurrent retries, deleted-file replay, existing files, namespace collisions,
reused operation identities, reminder ownership, and malformed Markdown.

## Per-sync timing diagnostics

New history entries store a local timing summary, kept in local settings for diagnostics. Phase durations use a monotonic clock and describe
the active phase; preparation that overlaps an upload is counted in the active
upload phase. “Saving checkpoint” measures that phase, not every cache or journal
write during other phases.

Request statistics include all requests in that sync, including failures, rather
than only the last 50 diagnostic records. Combined request durations include
concurrent waiting and must not be added to elapsed phase times. The Worker
reports request handling duration using `Server-Timing`; a response without it
leaves that measurement unavailable. This measures server elapsed time, not CPU time. The
client does not claim to measure pure network transit time separately.

These summaries are stored in local sync history and add no telemetry requests.

Servers also return `X-Crate-D1-Usage` with D1's `rows_read` and
`rows_written` metadata and the number of D1 queries, counted as Cloudflare's
per-invocation limit counts them (a `db.batch()` is one query). Local history and
exported diagnostics aggregate these as `timings.requests.d1`: `rowsRead`,
`rowsWritten`, `reportedRequests`, `completeRequests` and `queries`, and each
logged request records its own `d1Queries`. Internal synchronous coordinator
requests are included once, so a request's count can span two invocations. A header
without the query count is ignored. The meter wraps the existing statements; it adds no
database operations.

These are observed request costs, not the account's billing total. Background
reminder processing and maintenance run separately. Lost responses or database
failures can leave usage unreported; compare `completeRequests` with
the request count before treating a sync's request coverage as complete. Even with
complete request coverage, background work and other devices remain outside it.

Resuming an import prunes missing local paths through primary-key lookups, without
scanning the full remote inventory for each prune batch. Confirmed upload counts
survive later failures in both initial and ordinary sync entry points.

Hosted testing exposed Free Worker CPU exhaustion during sustained 32-file imports.
Initial uploads and bulk downloads now run through a fixed pool of eight instances
of the existing SQLite-backed Durable Object class after the public Worker checks
authorization. Each instance processes one decoded batch at a time to bound memory;
requests across the pool can run concurrently. Clients keep at most 4 batch downloads
in flight on desktop (2 on mobile), below the eight transfer instances, and a batch
download reads up to 6 R2 objects at once. These transfer instances persist no
Durable Object state. This adds one internal Durable Object request per batch,
without new D1 records or queries. Parsing, hashing,
R2 writes and publication use the object's default 30-second CPU allowance; the
public Worker's Free CPU allowance is 10 ms. The import's existing conditional writes,
upload leases and completion checks remain in use. See
[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
and [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
