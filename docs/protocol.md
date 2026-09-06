# Protocol 3 contract

`GET /.well-known/crate` publishes the current and oldest compatible protocol. The plugin and web app check it before writes. Every mutation must send `X-Crate-Protocol: 3`; missing or incompatible clients receive 428 before changing state. POST metadata and batch-download endpoints are reads. A failed portable-path migration returns 503 for authenticated writes until provisioning finishes.

## Files

R2 stores immutable bytes under opaque object keys. D1 commits `files`, changelog, retained versions, and Markdown projection intent together. An uncertain database response never authorizes deletion of staged bytes. Cleanup and orphan sweeps check live and retained references before removing objects; orphan cleanup has a 24-hour uncertainty window. Replaced/deleted versions are retained for 30 days.

Manifest and metadata entries, changelog puts, upload acknowledgements, and batch downloads include `revision`; individual downloads expose `X-Crate-Revision`. The revision identifies a file incarnation independently of its hash. Deletes require `expectedHash` and `expectedRevision`, captured from the acknowledged baseline. Missing revisions require reconciliation; a same-content recreation rejects an older delete. Uploads retain content-hash preconditions. Retrying identical bytes is only acknowledged when the current referenced R2 object verifies.

Batch uploads accept five files; batch deletes accept six. Both bound D1 work below the Free-plan 50-query limit with headroom for authentication and failure cleanup. The per-file byte limit is 25 MiB. Clients report skipped oversized files as errors.

## Reminders

All mutation requests carry a UUID `operationId`. The server hashes the canonical request and stores its response in the file transaction. A matching retry returns the recorded response; reusing an operation ID for a different request returns 409. Create IDs are permanently reserved after a committed web creation.

Update, completion, and delete require `expectedRevision`, a semantic digest captured when the editor or action begins, and the original source `filePath`. Moving a line or editing another reminder does not invalidate the semantic digest. Changes to the target reminder do. The server also applies file preconditions at commit. A cross-project move publishes both file updates and the receipt atomically.

Timed values persist UTC ISO instants, including seconds/milliseconds. Recurrence metadata stores timezone, count, end date, and progress in `crate-rule` comments. A manual change to the visible recurrence text invalidates hidden metadata. All-day values remain calendar dates; the saved server timezone determines notification time.

The web index reads at most 20 files and 2 MiB in aggregate per warming request, with a 1 MiB limit per note. Oversized notes and cache records produce persistent per-file issues, while other reminders remain available. Warming responses use 202 with progress counts and bounded retry delays. Web edits cannot grow a note beyond the 1 MiB index limit.

## Notification authority

`GET /reminders/notification-policy` reads the shared policy. POST initializes only an absent policy. PUT requires `expectedRevision` and explicitly updates folder, timezone, all-day time, or enabled state. These routes require a vault credential. Legacy direct schedule/cancel APIs return 410.

D1 projection jobs are created in the file transaction. A reserved Durable Object processes at most three files and five outbox jobs per alarm. Projection commits check the current file, policy, and job revisions. Delivery waits for a pending source projection and cannot overwrite state belonging to a newer schedule. Missed wakeups are recovered by scheduled maintenance.

Web sessions are limited to their enrolled folder, expire after 90 days, and cannot mint new sessions. A subscription belongs to its session; logout and expiry remove it. The deployment permits 20 subscriptions and five per owner. Notification writes are limited per network address/route to 30 per minute, enrollment to ten, and test pushes to three. Push requests accept only supported provider hosts, reject redirects, and have ten-second deadlines.

## Diagnostics and recovery

Responses expose `X-Crate-Request-Id`; mutation logs correlate client session, operation, device, and opaque file revisions without note content or filenames. Diagnostics report queues, failed projections, receipts, retained versions, and maintenance state. See [backup and recovery](recovery.md) for paired snapshots and isolated restore. Restoring only D1 cannot recover R2 bytes.

Limits are application guardrails, not a promise that every workload fits a free account. Measure CPU and account quotas with representative vaults before release; consult [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
