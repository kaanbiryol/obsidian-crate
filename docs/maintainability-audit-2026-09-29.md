# Second maintainability audit

## High-level assessment

Crate's TypeScript plugin, Worker and React PWA have useful domain boundaries and
substantial behavioral coverage. The first pass separated Reading's browser
lifetimes and sync-history workflows. This pass sampled reminder indexing and
watching, HTTP transport, deployment orchestration, local Reading storage, and
PWA composition. The important remaining findings concern asynchronous authority
and duplicated scheduling policy, rather than folder organization or file length.

## Biggest maintainability risks

1. **Late reminder scans can undo newer structural events.** In
   `src/reminders/data/reminder-index/index.ts`, `load` and `rescanFile` serialize
   reads, but `removeFile` and `renameFile` publish immediately. A queued or
   in-flight scan can subsequently restore a deleted path, old project, or stale
   source warning. A late identity-owner read can also normalize a note after it
   moves out of the configured folder. Publication and normalization need the
   same explicit invalidation at that boundary.
2. **Two layers own reminder debounce.** `VaultWatcher.handleModify` coalesces
   changes for 1.5 seconds; `ReminderIndex.rescanFile` separately discards requests
   made within 1.5 seconds of a scan. The latter can silently discard a newer
   requested edit, including work queued behind a slow read. The `force` argument
   makes callers responsible for knowing which requests are safe to drop.
3. **HTTP request authority is implicit across awaits.**
   `WorkerApiHttpClient.runRequest` waits for compatibility metadata before reading
   its mutable connection fields. A cached metadata result can permit a prepared
   mutation to use replacement credentials, and ordinary reads can return an old
   connection's response after replacement. Cache invalidation alone is not a
   request-lifetime guard.

## Recommended folder/module/package structure

Keep the current structure. These fixes belong at existing ownership boundaries:
the reminder index owns publication, the watcher owns event debounce, and the HTTP
client owns request authority. No new service layer or generic scheduling framework
is needed. Put regressions beside those modules so tests use their public methods.

## Large files / responsibilities to split

- `reminder-index/index.ts`: remove time-based event suppression and the `force`
  option. Keep scan serialization, structural invalidation and index publication
  together; splitting these would obscure the ordering being protected.
- `sync/worker-api/http.ts`: keep compatibility checks, dispatch, cancellation and
  response publication under one connection generation. Separate wire-contract
  validators remain in their existing modules.
- `pwa/main.tsx` and `cloudflare/deployment-service.ts`: retain their composition
  roles in this pass. Both delegate substantial work already. Their length alone
  does not justify adding another layer of callbacks or context objects.

## Concrete refactoring plan

1. Add delayed-scan and delayed-request regressions. Confirm that deletion,
   rename, queued work, consecutive content changes and cached-metadata connection
   replacement fail before making production changes.
2. Invalidate pending per-file scans when either of their paths changes. Re-read
   a full inventory if a structural event occurs before its publication. Track
   only pending work, releasing its invalidation records when it settles.
3. Make every accepted index rescan read current content. Keep the watcher's
   existing debounce and remove the now-redundant internal `force` parameter.
4. Capture HTTP connection identity before preflight and dispatch. Reject stale
   completion for both JSON and binary requests, retaining the existing timeout
   and non-cancellable Obsidian transport behavior.
5. Run focused regression, reminder/writer, transport, static and build checks.
   Existing schema-upgrade test failures and the unrelated Reading browser fixture
   stall from the first pass are separate baseline limitations.

Implemented all three findings. The initial 11 regressions failed before the fixes;
a further real-byte test reproduced the moved-note ID rewrite. Validation passed
the production build and typecheck, 179 reminder/sync test files, additional
focused full-scan normalization and HTTP failure cases, ESLint, and dead-code
checks. ESLint retains two pre-existing deprecation warnings. Native Obsidian
and physical-device behavior were not manually exercised in this pass.

## What not to change

Keep Markdown as the reminder source of truth, the existing scanner's identity
repair and atomic text-processing rules, immediate delete/rename feedback, and
the current plugin/Worker/PWA separation. Keep network retry and uncertain-write
reconciliation in their existing owners; changing credentials cannot cancel an
Obsidian request that has already reached the server. Avoid broad module moves,
new dependencies, public wire-protocol changes, or unrelated release edits.
