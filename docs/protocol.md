# Protocol 4 contract

`GET /.well-known/crate` publishes the current and oldest compatible protocol. The plugin and web app check it before writes. Every mutation must send `X-Crate-Protocol: 4`; missing or incompatible clients receive 428 before changing state. POST metadata and batch-download endpoints are reads.

## Files

R2 stores immutable bytes under opaque object keys. D1 commits `files`, changelog, retained versions, and Markdown projection intent together. An uncertain database response never authorizes deletion of staged bytes. Cleanup and orphan sweeps check live and retained references before removing objects; orphan cleanup has a 24-hour uncertainty window. Replaced/deleted versions are retained for 30 days.

Manifest and metadata entries, changelog puts, upload acknowledgements, and batch downloads include `revision`; individual downloads expose `X-Crate-Revision`. The revision identifies a file incarnation independently of its hash. Deletes require `expectedHash` and `expectedRevision`, captured from the acknowledged baseline. Missing revisions require reconciliation; a same-content recreation rejects an older delete. Uploads retain content-hash preconditions. Retrying identical bytes is only acknowledged when the current referenced R2 object verifies.

Batch uploads accept five files; batch deletes accept six. Both bound D1 work below the Free-plan 50-query limit with headroom for authentication and failure cleanup. The per-file byte limit is 25 MiB. Clients report skipped oversized files as errors.

Remote deletion on the plugin uses the vault's local trash regardless of the user's permanent-delete preference. The host moves the bytes present at removal, preserving an edit that arrives after the preflight hash check. Trash failures fail the operation without falling back to permanent deletion. `.trash` is always excluded from sync.

## Reminders

All mutation requests carry a UUID `operationId`. The server hashes the canonical request and stores its response in the file transaction. A matching retry returns the recorded response; reusing an operation ID for a different request returns 409. Create IDs are permanently reserved after a committed web creation.

The PWA stores the exact attempted request separately from its editable draft. An uncertain result retries that request first, then submits later edits under a new operation ID against the acknowledged revision. Definite validation rejections permit correcting the request. A 409 `operation_mismatch` rejects reuse of an operation ID without returning a receipt for different changes.

Update, completion, and delete require `expectedRevision`, a semantic digest captured when the editor or action begins, and the original source `filePath`. Moving a line or editing another reminder does not invalidate the semantic digest. Changes to the target reminder do. The server also applies file preconditions at commit. A cross-project move publishes both file updates and the receipt atomically.

Timed values persist UTC ISO instants, including seconds/milliseconds. Recurrence metadata stores timezone, count, end date, and progress in `crate-rule` comments. A manual change to the visible recurrence text invalidates hidden metadata. All-day values remain calendar dates; the saved server timezone determines notification time.

The web index reads at most 20 files and 2 MiB in aggregate per warming request, with a 1 MiB limit per note. Oversized notes and cache records produce persistent per-file issues, while other reminders remain available. Warming responses use 202 with progress counts and bounded retry delays. Web edits cannot grow a note beyond the 1 MiB index limit.

## Notification authority

`GET /reminders/notification-policy` reads the shared policy. POST initializes only an absent policy. PUT requires `expectedRevision` and explicitly updates folder, timezone, all-day time, or enabled state. These routes require a vault credential.

D1 projection jobs are created in the file transaction. A reserved Durable Object processes at most three files and five outbox jobs per alarm. Projection commits check the current file, policy, and job revisions and publish the expected notification token with each projection. That token is also the outbox command and alarm schedule identity. Delivery requires matching source, policy, and notification revisions, including after projection finishes but before the new outbox command arrives. Missed wakeups are recovered by scheduled maintenance.

The reminder Durable Object keeps the last completed due-time occurrence across schedule cleanup and restart. Replaying an accepted job cannot rearm that occurrence. Rescheduling the same due time preserves recipient progress and terminal failures; a new due time starts new delivery state. Token checks fence schedule cleanup while occurrence checks retain in-flight recipient acknowledgements for the same due time. Delivery callbacks are serialized. Unknown acknowledgements from an external push provider can still cause a retry; this is not an exactly-once provider guarantee.

Web sessions are limited to their enrolled folder, expire after 90 days, and cannot mint new sessions. A subscription belongs to its session; logout and expiry remove it. The deployment permits 20 subscriptions and five per owner. Notification writes are limited per network address/route to 30 per minute, enrollment to ten, and test pushes to three. Push requests accept only supported provider hosts, reject redirects, and have ten-second deadlines.

Recipient selection checks session existence, expiry, and folder authority at send time without waiting for maintenance. Every subscription requires a recorded authenticated owner. Logout revocation captures its credential before clearing local state and may finish dispatching afterward; ordinary old-session writes remain fenced.

## Diagnostics and recovery

Responses expose `X-Crate-Request-Id`; mutation logs correlate client session, operation, device, and opaque file revisions without note content or filenames. Diagnostics report queues, failed projections, terminal delivery failures, oldest failure/overdue timestamps, receipts, retained versions, and maintenance state. Terminal delivery failures persist in D1 before their alarm stops; the plugin reports them as a failed diagnostic with repair/rescheduling guidance. See [backup and recovery](recovery.md) for paired snapshots and isolated restore. Restoring only D1 cannot recover R2 bytes.

Limits are application guardrails, not a promise that every workload fits a free account. Measure CPU and account quotas with representative vaults before release; consult [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

## Supported storage formats

Only the current formats are supported: D1 `crate_schema` version 1, IndexedDB version 2, generation-bearing local file checkpoints, and URI-encoded `crate-desc:v1:` description comments. Unknown database/checkpoint formats are rejected and preserved. Signing out deletes the browser cache, including an unsupported cache. No format conversion or SQL upgrade path is bundled.
