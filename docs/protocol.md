# Protocol contract

`GET /.well-known/crate` publishes the current and oldest compatible protocol. The plugin and web app check it before writes. The current protocol is 1, with oldest compatible protocol 1. Clients send the highest mutually supported version in `X-Crate-Protocol`; missing or incompatible versions receive 428 before changing state. Restore requires the `restore-operation-receipts` capability and a durable operation regardless of the header version. POST metadata and batch-download endpoints are reads.

Native Shortcuts use a separate stable capture contract at
`/reading/shortcut/v1/{exchange,prepare}`. App protocol bumps do not change it.
The browser confirmation uses the live server's app protocol.
See [shortcut maintenance](reading-shortcuts.md) for the supported payloads,
template revisions, update guidance, and failure diagnostics.

## Files

R2 stores immutable bytes under opaque object keys. D1 commits `files`, changelog, retained versions, and Markdown projection intent together. An uncertain database response never authorizes deletion of staged bytes. Each upload records a 24-hour publication lease before writing R2. Cleanup claims expired leases and checks live and retained references before removing objects; claimed uploads cannot publish afterward. Cleanup uses tracked uploads and explicit cleanup queues without bucket-wide scans. Replaced/deleted versions are retained for 30 days.

Manifest and metadata entries, changelog puts, upload acknowledgements, and batch downloads include `revision`; individual downloads expose `X-Crate-Revision`. The revision identifies a file incarnation independently of its hash. Deletes require `expectedHash` and `expectedRevision`, captured from the acknowledged baseline. Missing revisions require reconciliation; a same-content recreation rejects an older delete. Uploads retain content-hash preconditions.

Single uploads require `X-Crate-Upload-Operation`; every batch member requires `operationId`. The ID binds the path, verified content hash, size, content type and expected hash. The file transaction records success or rejected preconditions in `upload_operations`. A retry returns that outcome, even after a later edit or deletion, without publishing bytes again. A new logical upload needs a new ID. IDs use the server-issued UTC day and 180-date expiry mechanism below. The plugin persists exact upload bytes before dispatch, recovers unresolved receipts before reconciliation, and checkpoints acknowledgement before removing its local journal. See [upload recovery and rename preservation](upload-recovery.md).

Batch uploads accept three files; batch deletes accept four. Both bound D1 work below the Free-plan 50-query limit with headroom for authentication and failure cleanup. The per-file byte limit is 25 MiB. Clients report oversized files on either side as skipped issues; they do not fail a sync or hold back the changelog cursor.

Live file paths form a portable filesystem namespace: no file may also be another file's parent, including case-insensitive or Unicode-normalized aliases. Each publication checks this inside its D1 transaction. A conflicting upload, restore or reminder move returns `namespace_conflict` with HTTP 409 (or a per-file batch status); preserve the local bytes and rename the conflicting file or parent folder before retrying. Same-path edits and delete-then-create replacements remain valid. Historical changes and metadata requests may include paths that no longer coexist; clients validate the final live manifest separately. Existing invalid remote namespaces require explicit repair on an originating device and are never resolved by automatically deleting one side.

Remote deletion on the plugin uses the vault's local trash regardless of the user's permanent-delete preference. The host moves the bytes present at removal, preserving an edit that arrives after the preflight hash check. Trash failures fail the operation without falling back to permanent deletion. `.trash` is always excluded from sync.

## Reminders

All mutation requests carry a stable `operationId`. The server hashes the canonical request and stores its response in the file transaction. A matching retry returns the recorded response; reusing an operation ID for a different request returns 409. Create IDs are reserved after a committed web creation; expired IDs cannot be used by a new create after cleanup.

New operation IDs use `e1_<eight-digit UTC day>_<random identifier>` format; new creates use that same ID for the reminder. The PWA obtains the day from uncached server metadata, independently of the device clock. Commands remain eligible for 180 UTC dates, with a monotonic D1 floor and a commit-time expiry guard; see [retry and retention](reminder-retention.md).

The PWA stores the exact attempted request separately from its editable draft. An uncertain result retries that request first, then submits later edits under a new operation ID against the acknowledged revision. Definite validation rejections permit correcting the request. A 409 `operation_mismatch` rejects reuse of an operation ID without returning a receipt for different changes.

Update, completion, and delete require `expectedRevision`, a semantic digest captured when the editor or action begins, and the original source `filePath`. Moving a line or editing another reminder does not invalidate the semantic digest. Changes to the target reminder do. The server also applies file preconditions at commit. A cross-project move publishes both file updates and the receipt atomically.

Timed values persist UTC ISO instants, including seconds/milliseconds. Recurrence metadata stores timezone, count, end date, and progress in `crate-rule` comments. A manual change to the visible recurrence text invalidates hidden metadata. All-day values remain calendar dates; the saved server timezone determines notification time.

The web index reads at most 20 files and 2 MiB in aggregate per warming request, with a 1 MiB limit per note. Oversized notes, malformed reminder metadata, and oversized cache records produce persistent per-file issues, while other reminders remain available. Warming responses use 202 with progress counts and bounded retry delays. Web edits cannot grow a note beyond the 1 MiB index limit.

Shared mutation validation rejects invalid input before normalization: titles are nonblank single-line text up to 1,024 UTF-16 code units; descriptions allow newlines and tabs up to 4,096 units after trimming. Invalid field types, control characters, unpaired surrogates and dates receive 400 instead of silently dropping values. Omitted fields and explicit clears remain distinct. Reminder parsing and editing require lossless UTF-8 without NUL characters; unsupported bytes remain available through generic file sync but cannot be rewritten by reminder edits.

## Notification authority

`GET /reminders/notification-policy` reads the shared policy. POST initializes only an absent policy. PUT requires `expectedRevision` and explicitly updates folder, timezone, all-day time, or enabled state. These routes require a vault credential.

D1 projection jobs are created in the file transaction. A reserved Durable Object verifies at most two sources and projects one file per alarm. A separate invocation of the same class dispatches up to ten outbox commands, five at a time, with its own query budget. Projection commits check the current file, policy, and job revisions and publish the expected notification token with each projection. That token is also the outbox command and alarm schedule identity. Delivery requires matching source, policy, parser and notification revisions, including after projection finishes but before the new outbox command arrives. Mutations run under the coordinator lock with a durable alarm stored before the write. No periodic notification recovery scan is needed.

The reminder Durable Object keeps the last completed due-time occurrence across schedule cleanup and restart. Replaying an accepted job cannot rearm that occurrence. Rescheduling the same due time preserves recipient progress and terminal failures; a new due time starts new delivery state. Token checks fence schedule cleanup while occurrence checks retain in-flight recipient acknowledgements for the same due time. Delivery callbacks are serialized. Unknown acknowledgements from an external push provider can still cause a retry; this is not an exactly-once provider guarantee.

Web sessions are limited to their enrolled folder, expire after 90 days, and cannot mint new sessions. A subscription belongs to its session; logout and expiry remove it. The deployment permits 20 subscriptions and five per owner. Notification writes are limited per authenticated session/route to 30 per minute, enrollment to ten, and test pushes to three. Push requests accept only supported provider hosts, reject redirects, and have ten-second deadlines.

The edge binding admits 60 notification writes per minute per source-address hash, hostname and Cloudflare location. After authentication, one D1 transaction applies the per-action and 1,000-per-UTC-day budgets. Invalid bearer credentials and invalid enrollment grants never charge these budgets; an exhausted action does not spend the daily budget. Valid enrollment exchanges use a separate daily pool from authenticated management. Unknown mutation routes and edge-denied requests perform no D1 work. Encrypted push messages fit within 4,096 bytes by truncating display text on Unicode code-point boundaries; stored reminder text stays intact. Deterministic payload failures stop delivery retries immediately.

Recipient selection checks session existence, expiry, and folder authority at send time without waiting for maintenance. Every subscription requires a recorded authenticated owner. Logout revocation captures its credential before clearing local state and may finish dispatching afterward; ordinary old-session writes remain fenced.

## Diagnostics and recovery

Responses expose `X-Crate-Request-Id`; mutation logs correlate client session, operation, device, and opaque file revisions without note content or filenames. Diagnostics report queues, failed projections, terminal delivery failures, oldest failure/overdue timestamps, receipts, retained versions, and maintenance state. Terminal delivery failures persist in D1 before their alarm stops; the plugin reports them as a failed diagnostic with repair/rescheduling guidance. See [backup and recovery](recovery.md) for paired snapshots and isolated restore. Restoring only D1 cannot recover R2 bytes.

Single and batch file deletes atomically persist a deletion receipt with the consumed file revision, a new opaque deletion revision, changelog sequence, original server request ID, authenticated device ID, and validated client session/operation IDs. The deletion revision is stored in the changelog and returned with `consumedRevision` and `deleteRequestId`; batch acknowledgements include per-file `results`. An absent-file retry returns the original matching receipt without attributing the deletion to the retrying request. A recreated file still rejects the stale delete. Receipts expire after 30 days; a later absent-file acknowledgement does not claim an expired or unknown deletion. Logs contain opaque correlation values, while the authenticated vault's database retains the path needed to investigate the event.

Limits are application guardrails, not a promise that every workload fits a free account. Measure CPU and account quotas with representative vaults before release; consult [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

## Supported storage formats

The [generated release contract](current-contract.md) lists current D1 schema versions and registered migrations. Other formats are parser version 1, IndexedDB version 1, version-1 generation-bearing authority-bound local file checkpoints with settled upload IDs and rename dependencies, ordered version-1 upload journals, and literal `crate-desc:` description comments, including multiline text. URI-encoded `crate-desc:v1:` comments are also supported and are written only when text contains HTML comment syntax (`--`), literal carriage returns or a leading encoding-like `v<number>:` prefix. Percent signs in literal descriptions remain unchanged; unknown version prefixes and malformed blocks remain errors. Provisioning uses the complete schema-1 baseline; unsupported database/checkpoint formats are rejected and preserved. Signing out deletes the browser cache, including an unsupported cache, and reports blocked cleanup. See the [compatibility matrix](compatibility.md) for upgrade, recovery and rollback policy.

## Source and occurrence integrity

A local download or merge is marked clean only after its current bytes and captured modification time verify together. A valid remote baseline with unverified local metadata remains detectable after restart.

Every successfully parsed Markdown file records its reminder identities and each dated occurrence’s first observation in the file transaction. If optional reminder parsing fails, general sync still commits the exact file bytes and a projection issue in that transaction, including without a notification policy or outside its folder. The previous verified identities, observations, and projections remain intact; uncertain parsing never authorizes cancellation. The web list and plugin diagnostics identify affected source paths. Publishing repaired content clears the issue and queues projection again; explicit file deletion remains authoritative. Observations survive title edits, renames and project moves. A reminder first observed before its deadline remains eligible when projection runs late. Delivery is attempted for up to 24 hours after its deadline; older eligible occurrences retain a failed-delivery diagnostic. Newly imported historical occurrences are not scheduled. Completed-occurrence receipts still suppress replay.

Duplicate identities within the configured reminders folder quarantine projection and are omitted from the web list with per-file issues. Editing an ambiguous identity returns 409. Committing a repair or deletion queues all affected source files again.

An explicit fresh enrollment link replaces a stored browser session, including an expired one. The exchange can accept the previous reminder credential solely to revoke that credential and its subscriptions; it cannot revoke a vault credential. The confirmed local cache is cleared before the new authority is installed, and other tabs adopt its folder. Pending commands and drafts remain scoped to their original folder for explicit review/recovery; only explicit logout discards them. When Obsidian changes the reminders folder, the session itself moves to the new folder and the web app switches to it without a new link. Commands it saved for the previous folder are not sent; they appear with damaged entries for export and removal.

Enrollment consumption, replacement-session creation and previous-session revocation commit atomically. A rolled-back exchange leaves the link usable. A response lost after a successful commit does not make that link reusable; open a new link from Crate to enroll again.

## Retained-version restore

`POST /sync/restore-version` requires `operationId`, `storageKey`, `path`, `expectedHash` and `expectedRevision`. An absent target uses null for both preconditions; an existing target requires its exact hash and revision. The plugin saves this complete intent in checkpoint format 1 before dispatch and resumes it after lost responses or restarts. Restores share the upload receipt table and its 180-UTC-date retry policy; the request fingerprint also binds the retained key and operation kind.

The file pointer, changelog entry and exact result receipt commit in the same D1 transaction. A retry reads that receipt before looking up retained bytes, so expiry of the retained version or a subsequent edit/delete cannot cause replay. A changed precondition is also recorded as a terminal result. The recovery dialog offers **Resume restore** for pending intents even when their original history entry has expired. Remote confirmation and local sync completion are separate: a failed local sync keeps the committed intent until a later successful sync. Expired unresolved operations require preserving the checkpoint and comparing the current remote state; never replace their operation IDs to force a retry.

## Initial import readiness

`resumable-initial-import-v1` is included in protocol 1. `/sync/import/complete` verifies the
file inventory in pages of up to 2,000 `[path, hash, size]` entries ordered by portable path
(UTF-8 byte order). Each non-final page returns the next `after` cursor; progress is bound to
the import generation, so an upload or prune between pages restarts verification. The `final`
page also proves no extra files exist, then seals the inventory and, when a reminder policy
exists, records pending reminder setup.
`POST /sync/import/readiness` checks the selected-folder scan and durable source,
projection and schedule queues, then atomically acknowledges readiness. Probes
return `{ ready: false }` while work remains, optionally with an error requiring
attention. Source errors include the affected note path. An additive `issues` array
contains up to 20 `{ path, message }` entries in path order, with optional `code` and
one-based source `line`; `moreIssues: true` means more notes need repair. Responses
still include the `error` string.
Plugin sync results and saved history keep explicit file context alongside their
text errors, enabling safe file-opening actions without parsing filenames from messages.
Issues whose wording Crate owns also carry a stable `code` from
`src/protocol/sync-issues.ts`, and Sync Activity chooses its explanation by code rather
than by message text. The Worker sends `reminder-note-too-large`,
`duplicate-reminder-id`, `invalid-markdown-encoding` and the reminder description
codes `invalid-description-block`, `invalid-description-encoding` and
`unsupported-description-encoding`. The plugin adds `file-too-large`,
`unsupported-device-path`, `vault-scan-incomplete`, `transfer-unverified` and
`more-reminder-issues`. Codes are
additive: older plugins ignore them, newer plugins drop unknown codes, and issues
without a code (OS, HTTP and transport errors, or older peers) fall back to message
matching.
`/sync/import` returns
the completed-upload session while its reminder setup is pending, allowing a
restarted client to resume without retransfers.
Local corrections sync before this acknowledgement so a failed reminder source
can be repaired. The client shows completion only after readiness is acknowledged. A cancelled
wait or the three-hour foreground wait bound leaves all progress intact.

## Shared history checkpoints

Protocol 1 includes `shared-history-checkpoints-v1`. Server-authored inventories are stored in R2 with a conditional shared
index, capped at 20 states and 30 days. Creation rejects a changing inventory;
publication retries deduplicate by monotonic server generation. No database schema
change or duplicate file-content storage is introduced. Retained-version expiry is
computed no earlier than 30 days after the D1 commit, preventing an older request
start time from expiring bytes before a checkpoint.

## End-to-end encryption

The server advertises `e2ee-v1`. Encryption is opt-in; an encrypted vault requires matching `X-Crate-Encryption-Vault` and `X-Crate-Encryption-Generation` headers. Servers store ciphertext hashes and sizes. Every server path segment is a 26-character lowercase base32 keyed tag of the plaintext name and its parent, with `.md` kept for Markdown (a note the server seals for the iPhone shortcut gets a random name of the same shape); the server rejects encrypted uploads at readable paths. Clients map plaintext paths to these server paths, check each file's authenticated private path against its server path, and authenticate/decrypt private descriptors before sync planning. Because names that differ only in letter case share one server path, clients report that `namespace_conflict` themselves. Existing bulk initial-import paths are disabled after activation; ordinary encrypted uploads retain their immutable receipt contract.

Encrypted reminder clients read their folder's ciphertext and publish one or two conditional note replacements plus encrypted operation acknowledgments. Scheduling sidecars publish only current IDs, completion and due values plus encrypted display envelopes. The server cannot validate their semantic correspondence to private Markdown; client decryption authenticates the sidecar digest. See [encryption format, setup and boundaries](e2ee-implementation.md).

`e2ee-reset-v1` adds a destructive, resumable transition that empties the server: from an encrypted vault to an unencrypted one, or from an unencrypted vault to an encrypted one when the request carries the new public encryption configuration. There is no in-place conversion of server data. A durable replacement credential, revoked old sessions, exact encryption-identity upload guards and completed reset receipts fence old clients and response-loss retries. The initiating device uploads its local vault; other devices reconnect and PWAs explicitly discard their previous session. See [encryption reset](e2ee-implementation.md#turn-encryption-off).

Every encrypted file uses the vault key. Reading has its own ciphertext listing/file/commit endpoints, but no public scheduling projection. Plaintext Reading mutation/extraction paths reject encrypted vaults. See [Reading encryption](reading-e2ee-assessment.md).

Changing the Reading or Reminders folder needs no re-encryption: folder policies change as in an unencrypted vault. In an encrypted vault, policies and reminders web app enrollments name the folder by its tag plus a label encrypted under the vault key, which clients open to recover the plaintext folder name.
