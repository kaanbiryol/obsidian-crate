# Reminder retry and retention policy

Protocol 6 gives new web commands a finite retry window without making an old request executable again after its receipt disappears. This policy covers web reminder mutations; generic file deletion audit receipts and retained file versions still use their separate 30-day policy.

## Commands and identities

The PWA reads uncached `/.well-known/crate` metadata before issuing a new command. `reminderOperationDay` is the server's UTC day number since the Unix epoch. A new operation ID is `e1_<eight-digit day>_<random identifier>`. The app never uses its device clock to choose that day. Failure to obtain compatible metadata keeps the open editor and draft intact. A new create must use its operation ID as its reminder ID; an existing reminder retains its original ID through edits, completion and moves.

The issued date and the following 179 UTC dates are valid. This is at least 179 and at most 180 elapsed days, depending on issuance time. Weeks offline and ordinary session renewal fit within the window. A retry keeps the exact operation ID and request bytes. The server checks a matching receipt first, so a retained receipt can still confirm an older commit. It rejects ID reuse with a different request hash.

Without a receipt, an unversioned legacy ID, future date, or expired date receives HTTP 410 `operation_expired` before staging vault data. The D1 publication batch checks expiry again: a request that expires while R2 is being staged cannot commit either side of a project move, file pointers, source metadata or a receipt. Private staged objects remain subject to existing orphan cleanup. An uncertain commit response still requires the same request on retry.

Maintenance atomically advances `maintenance_state.reminder_operation_floor` and then prunes at most 500 expired versioned receipts, 500 legacy receipts older than 180 days, and 500 expired unreferenced versioned identities per run. The floor never decreases; clock rollback cannot reopen an already-pruned window. Cleanup failure rolls back its floor and deletions together. Delayed maintenance may retain receipts longer, but cannot extend the ability of a missing-receipt request to mutate. Monitor maintenance failures and receipt counts through diagnostics.

Active and quarantined source references preserve identity reservations. Existing unversioned identity reservations remain permanently: they form a finite pre-upgrade set once protocol-5 writers are fenced. New creates cannot add such identities or reuse a pruned old identity with a fresh command. The generic Markdown path continues to preserve user-chosen stable IDs; this is separate from authorizing a new web create.

## Expired pending work

An expired result does not prove that an earlier attempt failed. The PWA keeps the exact request and draft, marks it for review, and stops automatic and manual replay across reloads, tabs and session recovery. Current confirmed reminder data is displayed for comparison, without overlaying the expired attempted save.

Select **Export expired change**, save the full JSON, and compare it with current reminders and vault files. After checking the export and current data, select **Remove exported change from device**. Removal runs under the outbox Web Lock and requires the current stored change to match the reviewed export. Changes made by another tab after export require another export. Restore only missing work as a new reminder or an intentional new edit. The application does not generate a replacement command automatically.

Protocol-5 applications cannot mutate a protocol-6 deployment. After updating the PWA, retained legacy receipts may confirm committed commands. A legacy command without a receipt takes the same review/export path. Independently saved drafts with no dispatched attempt can receive a new operation ID when saved.

## Notification occurrences

Each maintenance run removes at most 500 unreferenced occurrence rows, only when both the first observation and the due time are over 180 days old. Current and quarantined sources, future and recent due times, and unknown date formats remain protected. The source check and deletion occur in one SQL statement.

A restored obsolete reminder is observed after its old deadline and cannot be rearmed by projection. The normal notification delivery window is 24 hours. Each Durable Object also retains its last completed occurrence so cancellation or a repeated accepted job cannot immediately duplicate delivery; this constant per-identity record is separate from the D1 occurrence history.

## Recovery and evidence

Paired D1/R2 recovery preserves the operation floor, surviving receipts, identities and source observations. It does not grant a new retry window to archived commands. Resetting or lowering the floor manually, or installing a protocol-5 Worker over pruned data, breaks the guarantee; historical rollback requires isolated resources with its matching complete pre-upgrade archive.

Real D1/R2 tests cover both sides of expiry, late transaction rollback for completion and two-file moves, lost responses followed by restoration of the original semantic revision, create resurrection attempts, legacy receipts, active/quarantined identities, bounded and interrupted cleanup, and monotonic floors. Chromium and WebKit exercise exact export, reviewed removal, cross-tab changes, reloads and a device clock in 2099. Hosted execution and physical installed-app acceptance remain separate release checks.
