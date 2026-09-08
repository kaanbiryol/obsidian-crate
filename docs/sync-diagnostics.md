# Sync diagnostics

Automatic event-queue and periodic synchronizations are recorded in **Sync activity → History**, including errors and conflict counts. Idle checks do not add empty history rows. History is bounded and local to the plugin. A failed connectivity check changes the current status without changing the last successful sync time.

Run **Crate: Export sync diagnostics** in the command palette to review and copy a JSON report. The report includes plugin/protocol versions, sync counts and timestamps, recent request status, and opaque operation, request and client-session IDs. Each sync-history row preserves the most recent 50 request records for correlation after restart. The current session also retains a bounded 50-request snapshot. Snapshots can overlap across history rows; they are diagnostic context, not a count of unique operations.

The report omits vault names, Worker URLs, note paths/text, headers, tokens and free-form error messages. Inspect it before sharing; operation times and counts can still describe your activity. No report is sent automatically. Keep private local history when investigating a specific file: it contains the paths intentionally excluded from the shareable report.

An operator can correlate request IDs and client-session/operation IDs with `crate.mutation` Worker logs and retained deletion receipts. A timeout or cancellation means the response was unavailable; an Obsidian transport request can still commit remotely. Reconcile before retrying uncertain writes, and use receipt revision data to distinguish the original deletion from a later retry. Recovery still requires the paired D1/R2 backup described in [recovery](recovery.md).
