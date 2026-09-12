# Notification processing and database reads

Obsidian changes reach the server according to the device's sync settings. Web app changes reach it when their save request succeeds. Each committed Markdown mutation records its source state and affected notification work in the same D1 transaction. Mutations affecting reminder files, notification policy or explicit retries run under the coordinator Durable Object lock. Settings and binary uploads, deletions and restores do not wake notification processing. Sync checks and reminder-list access initialize migrations once per parser version. Upload transfer, hashing and R2 staging finish outside the lock; each Markdown publication then uses a short coordinated commit. Before routing a mutation, it persists an immediate alarm. The alarm cannot process work until the mutation releases that lock; if the request crashes after committing, the alarm still exists. There is no post-save wake-up gap or recurring notification cron. Only coordinated commits are serialized per vault; reads remain outside this lock.

The coordinator processes a bounded slice of changed files and sends version-checked schedule/cancel commands to each reminder's Durable Object. Those objects deliver notifications at their alarm time without polling the vault. Keeping the durable work record until acknowledgement protects against failed requests and concurrent edits.

Ready file jobs and retry deadlines have separate indexes. A shared per-file retry record covers both source verification and projection, so those stages cannot reset each other’s budget. Selection reads at most the requested number from each index; the next wake uses index heads instead of counting the queue. Temporary file failures retry after an hour; invalid encoding, malformed reminder metadata, oversized source files and conflicting reminder identities pause immediately until edited or explicitly retried. Alarm-dispatch jobs retain their exponential retry schedule. A new mutation brings a later coordinator alarm forward. An empty coordinator does not reschedule itself. Processing episodes stop after 24 hours, 10,000 passes, or eight coordinator failures. Pending jobs are retained, and a relevant mutation starts a new episode. Separately, transient file failures and alarm-update jobs pause after eight failures; unrelated mutations cannot reset that limit. A relevant file edit or an explicit retry can restart paused work. Individual reminder delivery already has an attempt/age limit; waiting for source authority now uses that same limit.

A full Markdown source scan runs once per parser version, with a durable cursor and completion marker. Subsequent invocations only process outdated or failed source records. Current file writes record source state atomically, so they do not require another full scan. Deleted legacy source records are removed in bounded slices, including after scan completion.

## Regression measurement

`notification-quota.integration.ts` measures `meta.rows_read` in the local Cloudflare D1 runtime with 2,000 and 10,000 queued files. At 2,000 files, the old job-selection and queue-count queries read 8,001 rows per pass; their replacements read 6. Both queue sizes must remain at or below 10 reads per pass, including queues containing only failures that are not due yet.

For 1,200 equivalent passes, 6 reads per pass projects to 7,200 reads for these two operations. This is not a total notification-processing estimate: file parsing, source verification, alarm updates, sync, and maintenance have their own reads. Production analytics should be checked after deployment.

Tests also cover eight-attempt limits, unrelated edits leaving paused work unchanged, manual retries, bounded reads with 10,000 paused files, and idle runs without file scans or database writes, exact retry deadlines, prompt wakeups for new work, parser-version migration, changes after migration, and deleted legacy rows.

## Rollout

Apply the additive indexes in `schema.sql` before uploading the Worker. The normal in-plugin server update already applies schema changes first. Deploying only the Worker is insufficient because processing requires the new notification_file_retries and staged_uploads tables and their indexes. If D1's daily allowance has been exhausted, schema changes may be blocked until the allowance resets; do not upload the dependent Worker first.

## Housekeeping without idle polling

An authenticated mutation arms a separate cleanup Durable Object for one run 24 hours later. Additional activity does not postpone an already scheduled run. Cleanup never wakes notification processing. If queued object cleanup advances and more remains, it schedules another pass five seconds later, up to ten passes total. A stalled backlog stops. Cloudflare can retry a thrown alarm failure a bounded number of times. An idle server therefore has no ongoing maintenance timer once that bounded episode finishes. Expired history or orphaned objects may remain until activity triggers another cleanup; expiry checks on authentication and access still apply.

Server updates clear the old cron schedule. Reminder alarms intentionally scheduled by the user remain active until delivery, cancellation, or their finite failure limit.

Paused updates appear in Run diagnostics. Retry paused notifications requeues up to 100 files and 100 alarm updates per explicit action and reports whether more remain. It does not resend completed deliveries; missed reminders still need to be rescheduled.

## Unfinished uploads

Every managed upload records a publication lease in D1 before writing R2. Publication checks that the lease is pending and unexpired, then removes the record in the same transaction that makes the file live. Lease creation and publication checks use the database clock.

Cleanup claims at most ten expired uploads per pass after 24 hours, checks live files and retained versions, and deletes only unreferenced objects. A claimed upload cannot subsequently publish. Missing objects retain their record because an in-flight upload may finish later. Unconfirmed cleanup retries at most eight times, then pauses with a diagnostic entry. Future expiry deadlines can schedule another alarm within the ten-pass maintenance episode; no permanent polling timer is introduced.

Older objects without upload records receive one resumable migration scan, after a 24-hour grace period. Its completion marker permanently disables further bucket listings. New uploads use indexed records rather than bucket-wide scans.
