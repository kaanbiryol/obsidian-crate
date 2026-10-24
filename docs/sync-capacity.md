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

## Testing notes

Choosing and running suites is covered in [testing](testing.md).

### Reminder capacity measurements

```bash
npm run benchmark:reminders
```

This repeatable local benchmark also runs as part of the Worker integration suite. Its verbose reporter emits structured measurements for 1,000 and 10,000 reminders: warm folders with one reminder per file, and cold folders with ten reminders per file. It verifies complete, unique results, cache-warming progress, and unchanged responses. It records wall time, response bytes and prepared SQL statements; it does not measure hosted CPU limits, real network latency, browser rendering or device memory.

On September 7, 2026, using Node 24.0.0 and local workerd after the cache decoding improvement:

| Scenario | Files | Reminders | Warm response range | Response bytes | Cold indexing requests |
| --- | ---: | ---: | ---: | ---: | ---: |
| One reminder per file | 1,000 | 1,000 | 13–25 ms | 288,930 | Not measured |
| One reminder per file | 10,000 | 10,000 | 117–133 ms | 2,898,930 | Not measured |
| Ten reminders per file | 100 | 1,000 | 17–28 ms | 276,240 | 5 |
| Ten reminders per file | 1,000 | 10,000 | 80–98 ms | 2,771,940 | 50 |

Warm lists prepared three SQL statements; unchanged requests prepared one and took 2–21 ms across these cases. Cold indexing took 137 ms and 1,772 ms of local request time, respectively. The browser additionally honors a one-second delay between warming requests: the 50-request case therefore incurs about 49 seconds of deliberate waiting, plus request time. These are local samples, not latency guarantees or a production capacity certification.

The full list still grows with folder size. Before promising support for large folders, repeat the 1,000/10,000 cases on a disposable hosted deployment and physical devices, recording Worker CPU/errors, D1 rows read, transfer size, time to first usable screen, scroll responsiveness and memory. If large folders are a release requirement, use these measurements to set the supported limit and evaluate a paginated per-reminder index; do not infer hosted support from the local pass.

Hosted capacity tests spend the account's shared D1 quota, even in a disposable
database. Run write-heavy fixtures locally by default. Before any hosted write
test, agree on a total row-write budget and account headroom; without one, the
hosted write budget is zero. Include index updates, reminder projections,
background jobs, retries and reset/deletion writes in the estimate. Do not infer
row-write cost from the number of requests or notes. Keep the 1,000/10,000-reminder
fixtures off a daily-quota-constrained account. For disposable resource cleanup,
delete the database through the resource API instead of resetting its rows just
to prepare it for deletion; empty R2 separately without D1 mutations.

#### Browser list capacity

`npm run benchmark:pwa` measures the production PWA with a local synthetic API in Chromium and WebKit at a 390 × 844 viewport. It is also included in `test:pwa-browser`. The test checks page navigation, off-page editing, saved changes, complete reorder payloads and bounded rendered rows at 1,000 and 10,000 reminders. The fixture deliberately stresses a single Inbox; it does not claim that 10,000 reminders fit the real per-file indexing limits.

The PWA now pages active, completed and date-grouped lists in batches of 200. A native page selector reaches any range. Paging affects rendered rows only: counts, cache, edits and reorder validation retain the full data. Obsidian's plugin views keep their existing behavior.

Cards within each page remain rendered offscreen. Avoid `content-visibility: auto`
on reminder rows: fast scrolling can expose unpainted cards and replace estimated
row heights mid-scroll. Run `node tests/browser/pwa/pwa-reminder-scroll-test.mjs` for
Chromium/WebKit checks of Today and Upcoming rendering before scrolling, rapid
scroll reversals with variable-height cards, and completion scroll anchoring.
Installed iPhone momentum scrolling still requires a physical-device check.

| Local 10,000-reminder Inbox | Before paging | With paging |
| --- | ---: | ---: |
| Chromium: first usable list | 7.24 s | 0.227 s |
| WebKit: first usable list | 23.07 s | 0.282 s |
| Mounted cards | 10,000 | 200 |
| DOM elements | 160,114 | 3,372 |

These are unthrottled local samples from September 7, 2026, with service workers disabled, not physical-device or network guarantees. The server still returns the full folder response. Reordering now accepts up to 10,000 IDs while retaining the 1 MiB request limit, stale-order checks and idempotent receipts; a real D1/R2 regression verifies reordering inside a 1,000-reminder project without changing other rows.
