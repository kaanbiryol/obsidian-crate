# Initial upload performance

An empty, never-populated remote uses the resumable initial import capability
`resumable-initial-import-v2` (protocol 1). The first device uploads the vault,
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

The local workerd/D1 billing-metadata regression measures **11,262 row writes for
10,000 ordinary notes**, including import setup and paged completion with 32-file batches.
The same fixture used 31,256 writes before the pre-release inventory redesign: a
20,000-write (64%) reduction. Eight-file batches now cost 15,010 writes, down from
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

The schema uses the normalized portable path as the `WITHOUT ROWID` primary key.
The original path remains metadata and is checked on exact-path reads and writes.
This preserves spelling, case/Unicode collision protection and file/folder guards
without a separate portable-path index. Manifest pages follow portable-key order
and still return original names and original-name continuation cursors. An empty, never-imported vault remains eligible for the cheap initial-import path.

Staging and cleanup records carry the owning file path. Current-object checks use
that primary key and immutable object revision; retained-object checks use the
existing version primary key. There is no current-file storage-key index.
Immutable keys are never
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
This layout is the schema-1 baseline. These
figures exclude device setup, actual reminder indexing, failures and cleanup, and
other activity sharing the account's daily quota. They do not guarantee that every
10,000-file vault consumes the same allowance.

Reminder indexing runs after import and only reads Markdown inside the selected
folder and its subfolders. Notes elsewhere receive no reminder source records,
parsing, quarantine, or notification work. Changing the selected folder retires
old source records and cancels old projections without reading those files.

Run the initial-import regression with:

```sh
npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/sync/initial-import.integration.ts --reporter=verbose
```

The normal eight-file upload path retains per-file receipts and changelog entries.
Its separate 8,000-note benchmark, with notes inside the selected reminder folder,
measures 52,000 row writes on a new database. This is a regression check for normal
uploads, not the cost of an initial import.

## Normal upload benchmark

The bulk new-file benchmark uploads 8,000 distinct Markdown notes of about 1 KiB
through the batch handler with real local workerd/D1/R2. Its timings exclude internet
latency, Obsidian disk work, authentication and Durable Object forwarding, so they
are not predictions of hosted completion times.

Run the benchmark with:

```sh
npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/sync/bulk-new-upload-benchmark.integration.ts --reporter=verbose
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
