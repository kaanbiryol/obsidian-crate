# Sync capacity and interrupted histories

These are local regression measurements of the production SyncEngine calling the production Worker with real local D1 and R2. The host vault adapter is an in-memory filesystem seam. They establish content preservation for the scenarios below; they do not measure hosted Worker CPU, billed rows, real filesystem latency, mobile memory, provider push delivery, or a physical-device soak.

## Repeatable workload

Run `npm run benchmark:sync` for the two capacity cases. The ordinary Worker runtime suite also includes them. Each case starts with empty test bindings, places roughly 1 KiB of distinct Markdown in each of 1,000 or 10,000 files across 100 nested folders, uploads to R2, downloads to a second independent device, performs unchanged syncs, closes both engines, then makes 100 disconnected edits, deletes, creates and renames. Both engines restart from their persisted checkpoints and converge. Every final local byte sequence, checkpoint path and remote manifest hash is checked.

The benchmark explicitly clears its test database and bucket between cases: the local runtime's reset helper alone retained D1 rows after a 10,000-file run. Setup/cleanup are outside the measurements. SQL counts are prepared statements, not billed D1 rows read or written. Response sizes include API bodies and base64 encoding where applicable. Timing assertions are intentionally absent; correctness and convergence are required regardless of machine load.

## Content conservation and storage failures

`sync/engine-history.integration.ts` adds eight cases using three actual engines and durable local checkpoints:

- Two disconnected renames retain both destination files in either arrival order.
- A stale third-device deletion cannot consume a recreated identical-byte incarnation, including a lost upload response and restart.
- A restarted offline edit merges after the change cursor and all remote ancestor versions expire; an offline deletion preserves the intervening remote edit.
- Three seeded histories each run twelve rounds of independent edits, varied arrival order, engine restart and periodic response loss after server commit. Every round checks all three local replicas and downloaded remote bytes.

`sync/storage-boundaries.integration.ts` adds three authenticated Worker/D1/R2 cases: exact 25 MiB attachment round-trip with matching SHA-256; streamed 25 MiB plus one byte rejected before any R2 write while the previous incarnation remains intact; and an R2 write failure before publication preserving the previous bytes, metadata and change history.

All four capacity cases, eight history cases and three storage-boundary cases pass. This complements the existing stale-write, namespace, local-discovery failure, uncertain-commit, recovery, and binary-conflict tests; it is a bounded regression corpus, not an exhaustive proof over arbitrary concurrent edits.
