# Initial upload performance

An empty, never-populated remote uses the resumable initial import capability
`resumable-initial-import-v2` (protocol 10). The first device uploads the vault,
completes its initial sync, and then additional devices download that vault.

Initial imports store file contents in R2 and current file metadata in D1. They
skip per-file upload receipts, changelog entries, retained versions, and reminder
processing. A shared staging lease covers up to 32 immutable object keys;
publication and cleanup remain transactional. Three client requests may be in flight,
with bounded preparation memory. Large attachments use binary requests.

Committed remote path/hash/size metadata is the resume checkpoint. After a
connection failure or restart, the client compares local bytes with that inventory,
skips matching files, uploads missing or changed files, and removes files deleted
locally during the pause. There is no expiry on committed import progress.

Upload completion verifies the inventory checksum and records one sync baseline.
The client then shows “Preparing reminder schedules” until the selected folder has
been verified, projected and its schedule/cancel queue has drained. A durable
marker resumes this phase after a restart without uploading unchanged files.
Reminder errors keep setup incomplete and are surfaced to the user; reminders
already overdue when first indexed do not receive catch-up notifications. Later
syncs use the normal change history and recovery receipts. Late import requests
cannot change a completed vault. Existing vaults and older servers retain the
normal upload path.

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

The local workerd/D1 billing-metadata regression measures **11,256 row writes for
10,000 ordinary notes**, including import setup and completion with 32-file batches.
The same fixture used 31,256 writes before the pre-release inventory redesign: a
20,000-write (64%) reduction. Eight-file batches now cost 15,004 writes, down from
45,004 before these optimizations. Replaying a committed batch writes zero rows
and uploads no R2 objects.

| Component, for 10,000 ordinary notes | Measured row writes | Purpose |
| --- | ---: | --- |
| Current file records | 10,000 | Remote identity, original spelling, content hash, size and object pointer |
| Shared staging leases | 939 | 313 batches, each with an insert, expiry-index entry and lease removal |
| Import generation checkpoints | 313 | Fence completion against batches still in flight |
| Session and completion | 4 | Open the import and publish its sync baseline |
| Total | 11,256 | No per-note history, upload receipts or reminder indexing |

When a reminder policy is configured, tracking and acknowledging initial reminder
readiness adds **two row writes per vault**, independent of note count, in addition
to the selected-folder scan and actual reminder processing. Pending readiness
probes write zero rows and use bounded indexed reads. Schedule dispatch handles
up to five commands in a separate invocation of the existing Durable Object class;
it adds one internal request per coordinator pass and no extra D1 records.

Schema 6 uses the normalized portable path as the `WITHOUT ROWID` primary key.
The original path remains metadata and is checked on exact-path reads and writes.
This preserves spelling, case/Unicode collision protection and file/folder guards
without a separate portable-path index. Manifest pages follow portable-key order
and still return original names and original-name continuation cursors. The one-time migration advances the snapshot baseline so a manifest started before the ordering change must restart safely. An empty, never-imported vault remains eligible for the cheap initial-import path.

Staging and cleanup records carry the owning file path. Current-object checks use
that primary key and immutable object revision; retained-object checks use the
existing version primary key. The current-file storage-key index is removed.
Legacy intents without an owner use a conservative whole-inventory scan only in
cleanup, never on the normal initial-upload path. Immutable keys are never
transferred to another file or reused by a restore.

The per-file inventory write is now the main cost. Cutting the remaining 1,256
writes would require larger batches or replacing durable batch leases and
completion fencing; these protect interrupted uploads and late requests.

Larger batches retain the 10 MiB decoded payload limit, bounded R2 concurrency,
conditional file writes, and resumable cleanup. Regression tests include byte-based
splitting, successful and rejected 32-file requests below 45 prepared D1 statements,
and selected-folder reads that remain bounded with 10,000 unrelated notes. Removing
the Markdown index means attachments inside the selected folder also participate in
its metadata scan; file content is still read only for Markdown. Files outside that
folder are skipped by the portable primary key.

This measurement uses the new database layout: `WITHOUT ROWID` for file metadata,
upload receipts, staging records, reminder verification, and projection jobs.
This layout is now the first-release baseline, with no historical inventory migration. These
figures exclude device setup, actual reminder indexing, failures and cleanup, and
other activity sharing the account's daily quota. They do not guarantee that every
10,000-file vault consumes the same allowance.

Reminder indexing runs after import and only reads Markdown inside the selected
folder and its subfolders. Notes elsewhere receive no reminder source records,
parsing, quarantine, or notification work. Changing the selected folder retires
old source records and cancels old projections without reading those files.

Run the initial-import regression with:

```sh
npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/initial-import.integration.ts --reporter=verbose
```

The normal eight-file upload path retains per-file receipts and changelog entries.
Its separate 8,000-note benchmark, with notes inside the selected reminder folder,
measures 52,000 row writes on a new database. This is a regression check for normal
uploads, not the cost of an initial import.

## Local benchmark, 2026-09-13

This historical timing comparison predates the resumable initial import and write-budget changes above.

Fixture: 8,000 distinct Markdown notes of approximately 1 KiB, four concurrent
requests, real local workerd/D1/R2. Both modes use the batch handler directly.
These timings exclude internet latency, Obsidian disk work, authentication, and
Durable Object forwarding. The second phase adds a separate namespace to the same
local database. They are not predictions of hosted completion times.

| Measurement | Previous path | Bulk new-file path |
| --- | ---: | ---: |
| Files | 8,000 | 8,000 |
| Upload requests | 2,667 | 1,000 |
| Prepared database statements | 101,334 | 36,000 |
| Commit transactions | 8,000 | 1,000 |
| Elapsed time | 28.620 s | 18.222 s |

The comparison shows 62.5% fewer upload requests, 64.5% fewer database statements,
and 87.5% fewer commit transactions. Local elapsed time decreased by 36.3%; hosted
performance must be measured separately.

Run the benchmark with:

```sh
npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/bulk-new-upload-benchmark.integration.ts --reporter=verbose
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
concurrent waiting and must not be added to elapsed phase times. Updated servers
report request handling duration using `Server-Timing`; older servers leave that
measurement unavailable. This measures server elapsed time, not CPU time. The
client does not claim to measure pure network transit time separately.

These summaries are stored in local sync history and add no telemetry requests.

Updated servers also return `X-Crate-D1-Usage` with D1's `rows_read` and
`rows_written` metadata. Local history and exported diagnostics aggregate these
as `timings.requests.d1`: `rowsRead`, `rowsWritten`, `reportedRequests`, and
`completeRequests`. Internal synchronous coordinator requests are included once.
The meter wraps the existing statements; it adds no database operations.

These are observed request costs, not the account's billing total. Background
reminder processing and maintenance run separately. Lost responses, older servers,
or database failures can leave usage unreported; compare `completeRequests` with
the request count before treating a sync's request coverage as complete. Even with
complete request coverage, background work and other devices remain outside it.

Resuming an import prunes missing local paths through primary-key lookups, without
scanning the full remote inventory for each prune batch. Confirmed upload counts
survive later failures in both initial and ordinary sync entry points.

Hosted testing exposed Free Worker CPU exhaustion during sustained 32-file imports.
Initial uploads and bulk downloads now run through a fixed pool of eight instances
of the existing SQLite-backed Durable Object class after the public Worker checks
authorization. Each instance processes one decoded batch at a time to bound memory;
requests across the pool can run concurrently. These transfer instances persist no
Durable Object state. This adds one internal Durable Object request per batch,
without new D1 records or queries. Parsing, hashing,
R2 writes and publication use the object's default 30-second CPU allowance; the
public Worker's Free CPU allowance is 10 ms. The import's existing conditional writes,
staging leases and completion checks remain in use. See
[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
and [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

## Hosted verification, 2026-09-14

An isolated Cloudflare Free deployment held 10,000 synthetic files: 8,000 Markdown
notes and 2,000 attachments, including twenty 1 MiB binaries. Twenty reminder notes
were inside `Reminders` and its subfolder; another valid reminder outside that folder
was deliberately excluded. Clients used the real SyncEngine and API transport with
isolated synthetic vault adapters, rather than physical Obsidian installations.

The run exercised process restarts, a lost successful upload response, edits and a
deletion during a paused import, and a changed large attachment. It verified zero
unchanged-file reuploads on resume. A fresh client downloaded all 10,000 files and
matched every SHA-256 digest against the source fixture. That final download took
376 seconds in this environment, made 228 API requests, read 30,464 D1 rows, wrote
zero D1 rows, and returned no errors. Device enrollment is outside this download
measurement; the synthetic clients shared a test vault credential.

Cloudflare analytics reported 32,103 D1 writes across the entire test
database. This includes schema/auth setup, reminder projection, interrupted attempts,
and additional final-route verification; it is not the ordinary-note-only benchmark
above. The final hosted upload route wrote exactly 100 rows for 32 new notes and zero
rows on an identical replay. It also successfully uploaded a 1 MiB binary and pruned
the temporary verification files. The completed database contained exactly 20 reminder
source records and 20 projections, all inside the selected folder, with no file-version,
upload-receipt or changelog rows.

The test uncovered CPU exhaustion in both direct Worker upload and bulk-download
handling. The final transfer-pool download completed without server errors; sampled
public Worker CPU during that phase was about 2.8 ms at P50 and 12.1 ms at P99. Those
percentiles describe the forwarding Worker, not total Durable Object CPU. Earlier
failed implementations are excluded from that CPU window. The test also exposed an
empty-folder scan marker created during setup: completing an import now resets that
marker so its newly uploaded reminder files are scanned. Finalization was replayed
on the isolated fixture to verify that fix before the successful download.
The synthetic Worker, D1 database and R2 bucket were deleted after verification.

## Schema-6 hosted D1 check, 2026-09-14

A temporary database verified migration through the same REST query API used by
provisioning. A failing statement after the table replacement rolled the entire
batch back. Successful migration preserved all 64 synthetic file rows and used
106 row writes, including schema changes and the new snapshot baseline. This
upgrade cost is separate from initial-import cost and varies with existing rows
and schema. Reapplying the current schema used zero writes. Inserting 32 additional
file records used exactly 32 writes. The temporary database was deleted.

The 11,256-write complete-import figure above is measured with local workerd/D1
billing metadata; the earlier hosted 10,000-file run predates the baseline inventory layout. No production
resources were changed during this verification.
