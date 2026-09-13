# Initial upload performance

New-file uploads use batches of up to eight files when the server advertises
`bulk-new-file-uploads-v1`. A batch requires absent-file preconditions. Existing
files continue through the normal conditional upload path. Older servers receive
smaller compatible batches with the same operation identities.

After bounded R2 staging, one D1 transaction inserts files with individual
namespace, absent-file, operation, and staging-lease guards. Change history and
reminder projection statements are shared across the batch. Recovery receipts
commit atomically with the files. A stale member cannot overwrite a remote file;
other members can still commit. Failed or uncertain transactions preserve staged
objects and original operation identities for retry.

Markdown publication still goes through the reminder coordinator. Staged content
is read before taking the coordinator lock, and the entire batch commits under
one lock. Unverified Markdown retains the existing quarantine behavior.

## Local benchmark, 2026-09-13

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
