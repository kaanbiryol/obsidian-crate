# Sync capacity and interrupted histories

These are local regression measurements of the production SyncEngine calling the production Worker with real local D1 and R2. The host vault adapter is an in-memory filesystem seam. They establish content preservation for the scenarios below; they do not measure hosted Worker CPU, billed rows, real filesystem latency, mobile memory, provider push delivery, or a physical-device soak.

## Repeatable workload

Run `npm run benchmark:sync` for the four capacity cases. The ordinary Worker runtime suite also includes them. Each case starts with empty test bindings, places roughly 1 KiB of distinct Markdown in each of 1,000 or 10,000 files across 100 nested folders, uploads to R2, downloads to a second independent device, performs unchanged syncs, closes both engines, then makes 100 disconnected edits, deletes, creates and renames. Both engines restart from their persisted checkpoints and converge. Every final local byte sequence, checkpoint path and remote manifest hash is checked.

The benchmark explicitly clears its test database and bucket between cases: the local runtime's reset helper alone retained D1 rows after a 10,000-file run. Setup/cleanup are outside the measurements. SQL counts are prepared statements, not billed D1 rows read or written. Response sizes include API bodies and base64 encoding where applicable. Timing assertions are intentionally absent; correctness and convergence are required regardless of machine load.

## Baseline local results

The record is based on `0288253` plus the S11 test additions, using Node 24.19.0. Full per-phase data, route counts, response bytes and R2 get/put counts are preserved in [the machine-readable evidence](audit-evidence/remediation/s11-sync-capacity.json).

| Notes | Upload path | Upload wall time | Upload requests | Prepared SQL | Cold download / requests | Settled unchanged / requests |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 | Cold full sync | 2.82 s | 2,002 | 11,008 | 0.44 s / 22 | 14 ms / 1 |
| 1,000 | Initial upload | 2.07 s | 672 | 9,008 | 0.39 s / 22 | 15 ms / 1 |
| 10,000 | Cold full sync | 29.32 s | 20,002 | 110,008 | 4.63 s / 206 | 126 ms / 1 |
| 10,000 | Initial upload | 20.70 s | 6,720 | 90,080 | 5.20 s / 206 | 120 ms / 1 |

At the baseline, initial upload batched small files while cold full reconciliation sent each upload individually. Both preflighted each mutation, making cold full sync materially more expensive over a network than the batched initial path. Downloads batch up to 50 small files, and settled unchanged synchronization uses one changes request. The first full sync following upload also establishes the remote cursor and can need a manifest read. A 10,000-file cold download returned about 19.8 MB of API bodies in this fixture; this is accumulated traffic, not a single response.

The largest-vault acceptance check must record real request latency, Worker CPU/errors, D1 rows, projection lag and device memory on the intended hosted deployment. These local times do not complete that acceptance check. The second-audit correction below addresses cold full-upload request amplification.

## Second-audit batching results

R04 uses the existing byte-budgeted preparation generator and three-file upload protocol during cold full reconciliation. Each file retains the remote hash observed by the plan, including an explicit absence guard. Large files retain the individual route; only confirmed uploads enter the checkpoint. Preparation errors and stale members remain visible and prevent cursor advancement.

The new [machine-readable measurements](audit-evidence/remediation/r04-sync-capacity.json) use Node 24.19.0 with the R04 implementation on base `93788f9`:

| Notes | Cold upload requests, before → after | New cold upload time | New prepared SQL | Explicit initial requests |
| --- | --- | --- | --- | --- |
| 1,000 | 2,002 → 674 | 1.98 s | 9,016 | 672 |
| 10,000 | 20,002 → 6,722 | 19.63 s | 90,088 | 6,720 |

Cold-upload requests fall by about 66%, while R2 still receives exactly one put per note. Byte budgets and per-request file limits stay unchanged. All four capacity cases still check final bytes/hashes after offline edits, deletes, renames and restart. Three additional real-Worker cases verify bounded request membership, confirmed revisions/progress, partial stale-write failure and response loss. A later edit after an unconfirmed first upload has no trusted merge base; it remains available in a visible conflict copy while the committed remote version is retained.

## Content conservation and storage failures

`sync-engine-history.integration.ts` adds eight cases using three actual engines and durable local checkpoints:

- Two disconnected renames retain both destination files in either arrival order.
- A stale third-device deletion cannot consume a recreated identical-byte incarnation, including a lost upload response and restart.
- A restarted offline edit merges after the change cursor and all remote ancestor versions expire; an offline deletion preserves the intervening remote edit.
- Three seeded histories each run twelve rounds of independent edits, varied arrival order, engine restart and periodic response loss after server commit. Every round checks all three local replicas and downloaded remote bytes.

`sync-storage-boundaries.integration.ts` adds three authenticated Worker/D1/R2 cases: exact 25 MiB attachment round-trip with matching SHA-256; streamed 25 MiB plus one byte rejected before any R2 write while the previous incarnation remains intact; and an R2 write failure before publication preserving the previous bytes, metadata and change history.

All four capacity cases, eight history cases and three storage-boundary cases pass. This complements the existing stale-write, namespace, local-discovery failure, uncertain-commit, recovery, and binary-conflict tests; it is a bounded regression corpus, not an exhaustive proof over arbitrary concurrent edits.
