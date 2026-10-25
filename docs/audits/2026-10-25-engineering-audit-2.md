# Engineering audit, second pass - 2026-10-25

Scope: the whole repository at `fd2f83ca`, after the fixes for the [first pass](2026-10-25-engineering-audit.md) landed (`3c934041..fd2f83ca`, 48 commits). Six area audits ran in parallel (sync and protocol; Worker, deployment and `packages/server`; reminders and reading; PWA; UI, plugin and encryption; build and CI). Each also reviewed the first-pass fix commits in its area. The lead re-read every cited location and its callers, reproduced the reminder line failure directly, and dropped or downgraded claims that did not hold (for example, a reported encrypted-delete loss that the device's own changelog echo already prevents). First-pass finding numbers are written as "first-pass F3".

Checks run on this commit after `npm ci` (Vitest 5.0.5, Playwright 1.64.1): `npm run lint` (0 errors, 3 warnings), `typecheck`, `typecheck:worker`, `typecheck:service-worker`, `deadcode`, `build` and `size-check` all pass, and `npm test` passes 5,389 of 5,389 tests. Worker-runtime, browser and visual suites were not run.

## 1. Summary

- The first pass's fixes are almost all correct. Every fix commit since the first pass was reviewed: six are incomplete (shared settings pull, typed-time DST drift, Reading re-projection after in-folder writes, coordinator wake for Reading GETs, earlier-session Reading caches, server picker leftovers) and one introduced a regression (Worker Reading writes now strip a UTF-8 BOM, L4).
- The top risk is setup: any vault file over 25 MB aborts the first device's initial import while sync history reports success (H1). A second device that connects during that unfinished import prunes the first device's uploads, and the first device's next sync can move its whole vault to trash (C1, needs a two-device runtime test to confirm).
- Shared reminder rules hold across plugin, PWA and Worker, but the plugin writer can emit a line its own parser rejects ("Read pages 13-19" with a date), which disables every reminder in that note on all hosts (H3).
- Several "locked forever" states remain at the edges: an encryption reset never completes while Reminders is paused (H4); a failed startup check in the PWA shows **Unlock Crate** for unencrypted vaults and deletes the offline reminder copy (H2); earlier-session outbox entries block PWA updates with nothing to review (M5).
- The shared settings fix (first-pass F2) now converges, but in the wrong direction after a restart: an edit that failed to save is silently replaced by the server's value (H6), and the startup pull never runs on a cold start (M1).
- D1 cost is still dominated by Reading: item lookups and the app's own Reading writes scan the whole folder, about 50k rows per action at 10,000 notes (H5). When the daily limit is reached, authentication turns the documented 429 into a 503 (M2).
- Build and CI: master has no green run at HEAD. The release gate and the Pages workflow stop on open advisories in `fast-uri` and in `undici`, which the self-hosted server ships as a runtime dependency (H8). A browser-launch failure hangs the Reading CI job for 15 minutes (M10).
- Dependency direction between areas is sound: the Worker imports only shared modules plus the PWA shell it serves, `core/` modules never import Obsidian, and `protocol/` depends only on `platform/`. Feature `plugin-integration` modules depending on `plugin/` is the intended registration pattern.
- The htmlparser2 deduplication (first-pass F18) recovered about 125 KiB each in `main.js` (now 4,650 / 4,855 KiB) and the Worker (3,813 / 3,989 KiB). Budget pressure has moved to the PWA: `app.js` is at 1,122 / 1,133 KiB (99%) and the startup assets at 1,825 / 1,846 KiB. Nothing large can be removed without a product decision (defuddle, lexical and react-dom dominate), so watch PWA additions.

## 2. Top 10

Ranked by impact divided by effort.

| Rank | Finding | Severity | Effort |
| --- | --- | --- | --- |
| 1 | H1 - A file over 25 MB aborts initial import and force full sync, which report success | High | S |
| 2 | H3 - The plugin writes reminder lines its own parser rejects, disabling the whole note | High | S |
| 3 | H2 - A failed PWA startup check locks unencrypted vaults and deletes the offline reminder copy | High | S |
| 4 | H4 - An encryption reset never completes while Reminders is paused | High | S |
| 5 | H8 - Known advisories block the release gate and Pages; `undici` ships in the self-hosted server | High | S |
| 6 | C1 - A second device joining an unfinished initial import wipes the first device's uploads | Critical | M |
| 7 | H5 - Reading item lookups and in-folder writes scan the whole Reading folder | High | S (a) / M (b) |
| 8 | H6 - A shared settings change that failed to save is reverted after a restart | High | S-M |
| 9 | H7 - Encrypted incremental sync skips the rest of the changelog after a fully filtered page | High | S |
| 10 | M1 - The startup shared settings pull never runs on a cold start | Medium | S |

Close runners-up with one-line fixes: M2 (daily-limit 429 masked as 503), M3 (recovery key regenerated per dialog open), L4 (BOM stripped by Worker Reading writes).

## 3. Findings by severity

### Critical

#### C1. A second device joining an unfinished initial import wipes the first device's uploads; the first device then trashes its own notes

- **Severity** - Critical (vault-wide removal from the server and from the first device into trash)
- **Dimension** - Robustness
- **Confidence** - Plausible. The client and Worker code paths are confirmed by reading; a two-engine `test:worker-runtime` run would confirm it end to end.
- **Evidence**
  - The import is one global row returned to any device while `state = 'importing'` (`src/cloudflare/worker/sync/import/initial-import.ts:16-31`).
  - A fresh device B treats every server file it lacks as obsolete and prunes it (`src/sync/engine/initial-import.ts:39-42`). The prune deletes the `files` rows and queues their objects for cleanup with no retained version (`src/cloudflare/worker/sync/import/initial-import-prune.ts:25-29`). B then finishes the import with its own inventory.
  - Device A's checkpoint still holds baselines for every file it uploaded (`initial-import.ts:85`). A's next sync finds the import complete, falls back to a full sync, and classifies each of those files as `delete-local` because local equals base and remote is gone (`src/sync/planner/reconciliation.ts:62-63`). No mass-delete guard exists in `planner/full.ts`.
  - H1 makes the trigger likely: A's import silently stops at any file over 25 MB while history shows success, and the user docs say to let the first device finish before connecting others.
- **Proposed fix** - Client only. Persist the import token in the checkpoint when this device first uploads or prunes for it. Prune or upload only when this device holds that token or the import inventory is empty; otherwise stop with "Another device is uploading this vault for the first time. Let it finish, then sync." No protocol change.
- **Effort** - M
- **Test to add** - Two-engine Worker-runtime test: A uploads part of its vault and stops; B (empty vault) syncs. Assert A's rows survive and A's next sync deletes nothing locally.

### High

#### H1. A file over 25 MB aborts initial import and force full sync, and both report success

- **Severity** - High (the first device can never finish setup while a large video or PDF exists)
- **Dimension** - Robustness
- **Confidence** - Confirmed (reproduced by the sync auditor through the persistent engine harness with a 26 MiB file; the lead confirmed no catch exists anywhere in the chain)
- **Evidence**
  - `src/sync/transfer/prepare.ts:23-26` throws `SkippedFileError` for oversized files. Initial import (`src/sync/engine/initial-import.ts:37,47-50`) and force sync (`src/sync/engine/force-sync-workflow.ts`) feed every discovered file into `pipelineUploadChunks` (`src/sync/transfer/budget.ts:55-80`), which does not catch it, so the workflow throws.
  - `handleWorkflowError` records it through `recordSyncError` (`src/sync/sync-outcome.ts:153`), which treats `SkippedFileError` as an issue, not an error (`src/sync/issues.ts:60-63`). `finalizeSyncResult` (`src/sync/sync-result.ts:98-103`) then returns `success: true`.
  - Initial import stops after `prune`, never calls `finish`, leaves `lastSeq` at 0 and repeats on every sync. Force sync uploads and deletes nothing and the settings notice reads "Server files replaced: 0 uploaded, 0 deleted".
  - Predates the first pass; neither workflow has a test with an oversized file.
- **Proposed fix** - In both workflows, filter `isOversizedSyncFile` (`src/sync/local/local-file-changes.ts:7`) out before chunking and record a `skippedFileIssue` per file; keep them in `localPaths` so their remote state is untouched. In `handleWorkflowError`, record any thrown error as a failure so an escaped `SkippedFileError` can no longer turn an aborted workflow into success.
- **Effort** - S
- **Test to add** - Persistent harness with two small files and one 26 MiB file: force sync uploads both small files, deletes the remote-only file and reports one `file-too-large` issue; `sync()` against an import-capable fake reaches `/sync/import/complete` and sets `lastSeq`.

#### H2. A failed PWA startup check locks unencrypted vaults and deletes the Reminders offline copy

- **Severity** - High
- **Dimension** - Robustness
- **Confidence** - Confirmed (unit reproduction of the deletion by the PWA auditor; the lead traced the lock and gate)
- **Evidence**
  - The encryption check falls back to the remembered state only when `navigator.onLine === false` (`src/pwa/connection/encryption.ts:45`). A network error, 5xx or bad body while "online" rethrows.
  - Reminders then call `requirePrivateStorageUnlock()` and publish `locked` (`src/pwa/reminders/encryption-session.ts:71`), which makes `privateStorageEnabled()` true (`src/pwa/reminders/private-storage.ts:12`).
  - The failing list load falls back to the disk copy (`src/pwa/reminders/useReminderSync.ts:196`), and `readIndexedDbSnapshot` treats a plaintext snapshot under private storage as a switch to encryption and deletes it (`src/pwa/reminders/cache/reminder-cache.ts:91-100`).
  - The gate maps `locked` to the **Unlock Crate** recovery-key card for a vault that has no encryption (`src/pwa/connection/AppConnectionGate.tsx:33,39`). Reading also locks and never retries on its own (`src/pwa/reading/session/useReadingConnection.ts:81`).
  - Triggers: a stopped self-hosted server, a captive portal, a 503 during a deploy, a flaky mobile network. The offline copy is destroyed exactly when it is needed.
- **Proposed fix** - (a) At `reminder-cache.ts:91`, delete plaintext only when a cipher is unlocked (`!!cipher`), not while merely locked. (b) Show a connection error instead of the unlock card when the check was unavailable, and let Reading retry on `online`/`visibilitychange`. This keeps the documented "any failed check locks reminders" policy. No format change.
- **Effort** - S
- **Test to add** - Unit: save an unencrypted snapshot, run `prepareReminderEncryption` against a 503, then `loadCachedReminderSnapshot`; the snapshot must survive. Browser (`pwa-cache-recovery-ui-test`): `/encryption` returns 503 while online; no **Unlock Crate**, and the offline list stays.

#### H3. The plugin writes reminder lines its own parser rejects, disabling every reminder in that note

- **Severity** - High (nothing lost on disk, but the whole note stops working on all hosts)
- **Dimension** - Robustness
- **Confidence** - Confirmed (the lead reproduced it: `buildCreatedReminderBlock({ content: 'Read pages 13-19', dueDate: 2026-10-30, hasTime: false })` writes `- [ ] Read pages 13-19 Oct 30, 2026 <!-- crate-id:... -->`, and `parseCheckboxLine(line, { persisted: true })` throws `UnresolvedReminderScheduleError` for that line)
- **Evidence**
  - The writer emits date-only dues as `MMM d, yyyy` text (`src/reminders/core/grammar/checkboxParser.ts:205-211`). The persisted parser reads `13-19 Oct` as a yearless date and throws (`src/reminders/core/grammar/reminderParser.ts:66-67`). Titles ending in a number range ("Pages 20-30", "Sprint 14-28") are affected; timed reminders are not.
  - In the plugin, the scan error becomes a source issue for the whole file (`src/reminders/data/vaultScanner.ts:181-191`), the optimistic record keeps `repository.create` reporting success (`src/reminders/data/reminder-index/index.ts:157-160`), and completing any other reminder in the note is refused (`src/reminders/data/markdown-writer/index.ts:44-45`). This bypasses the read-back check added in 852fd7d1.
  - After the line syncs, the Worker records a source issue (`src/cloudflare/worker/reminders/source-parse.ts:64-69`), web app edits to any reminder in that note fail (`src/reminders/core/reminderFileCommand.ts:104`), and notification projection for the note throws (`src/cloudflare/worker/notifications/projection.ts:66-67`). The Worker itself refuses the same create before writing (`reminderFileCommand.ts:69-77`).
- **Proposed fix** - In `buildCreatedReminderBlock` and `buildUpdatedReminderBlock`, parse the built line with `{ persisted: true }` and throw the existing `ReminderInputError('content', ...)` when it throws or returns a different title or due. Every host then refuses before writing; the persisted-parse cache makes it nearly free. Fixing the grammar to anchor the writer's trailing date token (which would also recover existing notes) needs a parser cache version bump per `docs/compatibility.md`, so do it separately.
- **Effort** - S
- **Test to add** - Core: building "Read pages 13-19" with a date-only due throws. Plugin (harness in `src/reminders/data/reminder-scan-parse-count.test.ts`): `repository.create` rejects, the note bytes are unchanged, and `index.sourceIssues` is empty.

#### H4. An encryption reset never completes while Reminders is paused

- **Severity** - High (the server stays in `resetting`, returning 423 for every other route; local data is safe)
- **Dimension** - Robustness
- **Confidence** - Confirmed by code path (the existing runtime test only covers enabled features)
- **Evidence**
  - Pausing Reminders keeps `scheduled_reminders` rows. Starting the reset turns each into a cancel job (`src/cloudflare/worker/encryption/reset.ts:75-78`); the feature policy survives until completion (`reset.ts:108`).
  - Each reset step calls `drainNotificationCancellations` (`src/cloudflare/worker/notifications/outbox.ts:33-37`), which dispatches without the reminders-enabled header (`coordinator/coordinator.ts:105`), so `drainNotificationJobs` returns immediately when Reminders is off (`outbox.ts:80`).
  - The remaining-work query therefore always finds rows and `advanceReset` returns before completing (`reset.ts:91`). Reminders cannot be re-enabled because every route except the reset returns 423, and all other devices are already revoked.
  - The plugin retries up to 10,000 reset requests back to back (`src/sync/encryption/reset.ts:125`), and each rewrites every cancel row (`outbox.ts:34`): about 500k D1 writes for 50 reminders, five times the Free-plan daily allowance.
- **Proposed fix** - In `drainNotificationCancellations`, call `dispatchNotificationJobs(env, true)`; the reset turned every job into a cancel and nothing can schedule while resetting. Also add `AND available_at != 0` to the `UPDATE` so only changed rows are written. No protocol, schema or server revision change beyond the normal Worker update.
- **Effort** - S
- **Test to add** - Worker-runtime in `reset.integration.ts`: policy `reminders: false`, 14 `scheduled_reminders`, start and finish the reset; expect `complete: true` and both tables empty.

#### H5. Reading item lookups and the app's own Reading writes scan the whole Reading folder

- **Severity** - High at the documented 10,000-note library on the Free plan
- **Dimension** - Scalability
- **Confidence** - Confirmed with `EXPLAIN QUERY PLAN` and step counts on the real schema (10,000 notes); D1 row totals inferred, not metered
- **Evidence**
  - `sourceById` (`src/cloudflare/worker/reading/common.ts:51-53`) and the duplicate-link check (`reading/mutations.ts:31-33`) use `(s.path, s.revision) IN (SELECT path, storage_key FROM files WHERE FILE_FOLDER_MATCH)`. SQLite materializes the whole folder range: 100,035 steps versus 37 for a primary-key lookup. This runs for every `/reading/item` (the PWA prefetches up to 10 per refresh), every update or retry, and every capture.
  - 9a4d9d8a skips projection only when nothing in the folder changed (`reading/projection.ts:33-40`). Every Reading action writes inside the folder, so the next `projectReading`, which `mutateReading` runs first (`mutations.ts:20`), does a full pass of about 4x the folder size.
  - At 10,000 notes one "mark as read" costs about 50k rows read; about 100 actions a day exhaust the 5M daily allowance, after which every route returns 429. `src/cloudflare/worker/reading/d1-usage.integration.ts` uses a one-note folder, so it cannot catch this.
- **Proposed fix** - (a) Replace the `IN (...)` with a correlated `EXISTS (SELECT 1 FROM files f WHERE f.path = s.path AND f.storage_key = s.revision AND <folder match on f>)`, which probes `files` by primary key. (b) In `projectReading`, when `changedPathsSince` returns a short list (25 or fewer paths), restrict the delete and left-join statements to those paths; keep the full pass otherwise. No schema or protocol change.
- **Effort** - S (a), M (b)
- **Test to add** - Worker-runtime, extending `d1-usage.integration.ts`: 2,000 Reading notes; `item?id=`, `update` and the following `projectReading` each read fewer than 100 rows.

#### H6. A shared settings change that failed to save is reverted after a restart

- **Severity** - High (an exclusion the user added can be silently removed, and excluded files start uploading)
- **Dimension** - Robustness
- **Confidence** - Confirmed (temporary test against `createSharedSettingsSync`)
- **Evidence**
  - The tracker's base is this device's settings at creation (`src/plugin/shared-settings-sync.ts:23-24`), created at startup and never persisted. A failed push only logs (`:76-79`), so "stays pending for the next close" (`:20`) holds only in memory.
  - After a restart the base equals the local settings, so `rebaseSharedSettings` (`:63`) sees no local edit and `pull()` writes the server's values over it. Example: add `Private/` to exclusions offline, close settings, quit; the next pull restores the old patterns and `Private/` syncs. Before a7030a8c the edit stayed local and diverged; now it is lost.
  - Plausible related race: `pull()` does not refresh an open settings tab, and the exclusions field commits stale text on blur (`src/ui/settings/input-helpers.ts:18-19`), which the push on close then sends to every device.
- **Proposed fix** - Persist the last reconciled server settings as `sharedSettingsBase` in plugin data (cleared when `workerUrl` changes), start the tracker from it, and update it in the same `writeSettings` that adopts server values. Skip `pull()` while the settings tab is open. One optional `data.json` field; older versions ignore it.
- **Effort** - S-M
- **Test to add** - `shared-settings-sync.test.ts`: a tracker with a saved base that differs from local keeps the local value on `pull()` and sends it on the next `push()`.

#### H7. Encrypted incremental sync skips the rest of the changelog after a fully filtered page

- **Severity** - High (sync divergence in encrypted vaults; narrow trigger)
- **Dimension** - Robustness
- **Confidence** - Confirmed mechanism; trigger Plausible
- **Evidence**
  - In encrypted vaults, `getChanges` drops deletes for server paths this device never synced (`src/sync/worker-api/sync.ts:284-286`). If all 5,000 raw entries of a page are such deletes, the filtered page is empty while `hasMore` is true.
  - `readIncrementalChangelog` stops on an empty page (`src/sync/planner/incremental-changelog.ts:27`) and returns `latestSeq`, which is the server's global last sequence (`src/cloudflare/worker/sync/metadata-handlers.ts:41-48`). `incremental.ts:171` saves it, so every change after that page is skipped until the cursor expires.
  - Trigger: another device deletes 5,000 or more files that this device never synced, for example a large folder excluded here and cleaned up from another device. The raw-page validation (`read-contracts.ts:43`) does not apply to the filtered page.
- **Proposed fix** - In `getChanges`, return the raw page's last sequence alongside the filtered changes and let `readIncrementalChangelog` keep paging while `hasMore` is set, advancing `since` from the raw page. No protocol change.
- **Effort** - S
- **Test to add** - Unit: a fake API returning one page of 5,000 unknown deletes with `hasMore`, then a page with one put; the put is applied and `lastSeq` equals the second page's last sequence.

#### H8. Known advisories block the release gate and Pages; `undici` ships in the self-hosted server

- **Severity** - High (no release can pass the gate; a runtime dependency of the published server has high-severity advisories)
- **Dimension** - Code quality
- **Confidence** - Confirmed for the advisories and the blocked jobs (Pages run at `fd2f83ca`); runtime exposure of the self-hosted server Plausible (Miniflare's outbound `fetch`, used by Reading captures of arbitrary URLs, goes through `undici`)
- **Evidence**
  - `npm audit` reports `fast-uri` 3.1.8 (4 advisories, moderate, dev only) and `undici` 7.29.1 (high: EventSource memory DoS, SRI bypass, DoS on excessive content-encodings).
  - `undici` is pinned as a runtime dependency of the published server (`packages/server/package.json:34`) and through the Miniflare override (`package.json:173`).
  - The gate uses `--audit-level=low`, so `security:check` fails in `verify.yml` and in `pages.yml:123-124`; every Pages run since 2026-10-24 stopped there, skipping `check:docs` and `build:site`. Master's latest completed "Node.js build" (`33b27c74`) failed the same step, and the in-progress run at `fd2f83ca` already shows it failing again.
  - Open Dependabot PRs: #43 (`fast-uri` 3.1.9) and #36 (`undici` 8.12.3, a major bump that Miniflare may not accept).
- **Proposed fix** - Merge #43. Move both `undici` pins together to the first patched 7.x release if one exists; otherwise evaluate #36 against `test:worker-runtime` and `test:docker`. Then bump the server revision per `docs/server-upgrades.md`. Separately, delete the duplicated `security:check` step from `pages.yml` (section 4).
- **Effort** - S
- **Test to add** - `npm run security:audit` passes; the next Pages run reaches `build:site`.

### Medium

#### M1. The startup shared settings pull never runs on a cold start

- **Severity** - Medium (first-pass F2 fix is incomplete)
- **Dimension** - Robustness
- **Confidence** - Confirmed (temporary test against `registerSharedFeatures`; lead re-read the startup order)
- **Evidence** - `registerSharedFeatures` runs during `onload` (`src/plugin/lifecycle.ts:60`) and calls `pull()` immediately (`src/plugin/feature-settings.ts:71`), but the runtime's API client exists only after `initialize()` (`src/sync/runtime/runtime.ts:293`), which waits for layout ready (`lifecycle.ts:52-56`). `pull()` returns at `shared-settings-sync.ts:55`, while `/features` succeeds and sets `lastRefreshAt`, gating the next pull for 10 minutes (`feature-settings.ts:72,79-80`). The catch-up sync after launch, and short mobile sessions, use stale exclusions.
- **Proposed fix** - Call `void sharedSettingsSync(plugin).pull()` in `initializePluginSync` after `initialize()` resolves (`lifecycle.ts:118`). One line.
- **Effort** - S
- **Test to add** - Cold-start test: one `GET /settings` once the API client exists, and remote `ignorePatterns` adopted before the next sync.

#### M2. Hitting the D1 daily limit during authentication returns 503 instead of the documented 429

- **Severity** - Medium
- **Dimension** - Robustness
- **Confidence** - Confirmed for the read limit (temporary unit test); Plausible for the write limit
- **Evidence** - `src/cloudflare/worker/auth/authenticate.ts:94-96` maps every D1 error to 503 "Authentication service unavailable", so `request-handler.ts:176-178` never returns `d1_daily_limit`. The last-seen `UPDATE` (`authenticate.ts:72-79`) is in the same `try`; once writes are exhausted it fails on every request whose timestamp is stale, so even reads with that token return 503 until 00:00 UTC. The request is also counted as unauthenticated (`request-handler.ts:118`). Contradicts `docs/worker-api.md:555-557`; the plugin's daily-limit guidance never shows.
- **Proposed fix** - Rethrow when `isD1DailyLimitError(error)`, and wrap the last-seen `UPDATE` in its own `try` that ignores failure (it only feeds the device list). About 4 lines.
- **Effort** - S
- **Test to add** - `src/cloudflare/worker/index.test.ts`: a bearer request whose DB throws the daily-limit error gets 429 `d1_daily_limit`; a DB where only the `UPDATE` throws still authenticates.

#### M3. **Enable encryption** shows a new recovery key every time the dialog opens

- **Severity** - Medium (irrecoverable only if every unlocked device is also lost)
- **Dimension** - Robustness
- **Confidence** - Confirmed
- **Evidence** - With no saved keys, each `loadContent` (every open and **Retry connection**) runs `prepareEncryptionKeys`, which creates a new bundle and recovery code (`src/ui/settings/encryption/encryption-section.ts:129`, `src/plugin/encryption-setup.ts:41-44`). Nothing is saved until encryption starts, and there is no paste-back step (`docs/e2ee-implementation.md:11`). Copy key A, close the dialog to store it, reopen, enable: the server envelope is sealed with key B.
- **Proposed fix** - Keep the prepared `{ bundle, recovery }` in a per-plugin `WeakMap` keyed by `workerUrl` until encryption starts. About 5 lines.
- **Effort** - S
- **Test to add** - Opening the modal twice on an unencrypted server shows the same recovery key.

#### M4. The Activity pending list re-checks every file whenever the pending set changes

- **Severity** - Medium
- **Dimension** - Performance and speed
- **Confidence** - Confirmed counts (temporary test with 5,000 keys); real-DOM timings not measured
- **Evidence** - Any change to the key list disposes and rebuilds the browser (`src/ui/activity/activity-modal.ts:123-134`), restarting comparisons from index 0 with an empty cache: adding one key caused 5,001 `loadDiff` calls (stat, read, SHA-256 and diff each; 2-3 Worker requests per modified non-Markdown text file, `src/sync/pending/pending-baseline.ts:16-21`). One render of 5,000 rows creates about 45k elements and 35k listeners (`pending-browser.ts:133-190`). This happens after every **Sync files** or **Discard** in the modal.
- **Proposed fix** - Auto-check only when there are 200 or fewer paths (others load when selected), and keep finished status labels in `PendingBrowserState` keyed by pending key so a rebuild checks only new keys.
- **Effort** - S
- **Test to add** - With 5,000 keys, a rebuild that adds one key performs at most one load.

#### M5. Earlier-session reminder changes in an earlier folder block every PWA update but appear nowhere

- **Severity** - Medium
- **Dimension** - Robustness
- **Confidence** - Confirmed (unit reproduction)
- **Evidence** - `hasUnsettledReminders()` blocks on any `crate-reminder-outbox:` key (`src/pwa/reminders/outbox/reminder-outbox-storage.ts:197`), but the UI shows only same-token keys (`:105`) and same-folder keys (`:148-154`). A change from token T in folder A, after the folder moved to B and the session was replaced, is neither loaded nor quarantined, so `applyPwaUpdate` refuses with nothing to review until logout erases everything.
- **Proposed fix** - Widen the quarantine scan to every `v1:` outbox key outside the current scope that recovery storage does not own, so it appears under **Damaged pending changes** with the existing export and reviewed removal. Update the storage recovery doc.
- **Effort** - S
- **Test to add** - Store a change for (token-a, Reminders), open (token-b, Tasks): `quarantined()` includes it and `removeQuarantined` makes `hasUnsettledReminders()` false.

#### M6. Reading offline data from earlier sessions is never pruned

- **Severity** - Medium
- **Dimension** - Scalability
- **Confidence** - Confirmed (reproduction: two sessions keep 400 articles, about 80 MB against the 50 MiB policy)
- **Evidence** - Reading data is keyed by session ID, which changes with the token and the folder generation (`src/pwa/reading/api.ts:41`, `src/cloudflare/worker/reading/access.ts:26`). The 200-article / 50 MiB cap only applies to the current session (`src/pwa/reading/storage/cache.ts:84,128-157`), so every 90-day re-enrollment or folder change leaves another full copy until logout. 3a180e19's removal deletes `pending:` keys but leaves `attempt:` keys (`storage/storage.ts:70-80`).
- **Proposed fix** - After a successful `commitReadingCache`, in the same transaction, delete other sessions' list, index and readable article keys; keep `pending:`, `draft:`, `attempt:` and unreadable records. Delete an earlier session's attempts when its queue is removed. No format change.
- **Effort** - S-M
- **Test to add** - `cache.test.ts`: articles cached under session A, commit under B; no `article:A:*` or `list:A` remains and `pending:A` survives.

#### M7. Startup walks the whole vault three times, listing every folder each time

- **Severity** - Medium
- **Dimension** - Performance and speed
- **Confidence** - Confirmed count by code reading; time cost Plausible (measure on a large mobile vault)
- **Evidence** - With automatic sync on, startup runs `getAllVaultFiles` for conflict recovery (`src/sync/engine/engine.ts:224-225`), for the startup sync (`src/sync/planner/local.ts:37`) and for the post-sync probe (`src/sync/runtime/startup-sync.ts:31`). Each call lists every non-ignored folder to find nested hidden folders (`src/sync/local/file-discovery.ts:186-219`): about 6,000 `adapter.list` bridge calls for a 2,000-folder vault. The probe exists only because the runtime drops events while not accepting them (`src/sync/runtime/runtime.ts:485-506`). The periodic check walks the same way every interval when nothing remote changed (`local-file-changes.ts:29`).
- **Proposed fix** - Record paths of events dropped while `!acceptingEvents` in a `Set` and restore them as pending keys after the startup sync (`queueController.restorePendingPaths`) instead of the third walk. The existing pending verification already settles echoes and timestamp-only touches.
- **Effort** - S-M
- **Test to add** - Runtime harness with N folders: count `adapter.list` calls across startup (2 walks, not 3); an edit made during the startup sync still syncs.

#### M8. Every Worker request copies the response body as text, including 25 MiB binary downloads

- **Severity** - Medium
- **Dimension** - Performance and speed
- **Confidence** - Plausible (confirm in the Obsidian console that `RequestUrlResponse.text` is a lazy getter)
- **Evidence** - `src/sync/worker-api/http.ts:49-54` reads `response.text` for every request, although `requestBinary` needs only `arrayBuffer`. A 25 MiB attachment then also becomes a string of up to about 50 MB, with two downloads in flight, on top of the 48 MiB mobile transfer budget.
- **Proposed fix** - Return the `requestUrl({ ..., throw: false })` result directly; `RequestUrlResponse` already satisfies `ApiHttpResponse`. Deletes the remapping.
- **Effort** - S
- **Test to add** - Mock `requestUrl` with a counting `text` getter; a 2xx `requestBinary` never reads it.

#### M9. A Cloudflare login that expires during a fenced deployment step leaves the deployment lock held

- **Severity** - Medium (updates and resets stuck; no data loss)
- **Dimension** - Robustness
- **Confidence** - Confirmed mechanism (temporary `fence` test); frequency Plausible (depends on real token lifetime)
- **Evidence** - The saved login is renewed only when under 60 s remain at operation start (`src/cloudflare/usage/connection.ts:126`). A Cloudflare 401/403 surfaces as `CloudflareReauthorizationRequired` (`src/cloudflare/deployment/service.ts:344`), but `src/cloudflare/deployment/fence.ts:77` marks a step rejected only for a 4xx `CloudflareApiError`, so the step stays `started`, `finish()` keeps the lock (`fence.ts:122`), and recovery blocks on it (`src/cloudflare/deployment/recovery.ts:89-93`), pointing the user to `scripts/crate-deployment-fence.py`.
- **Proposed fix** - In `mutate`'s catch, treat `CloudflareReauthorizationRequired` as `rejected` (inside `mutate` it can only mean Cloudflare refused the request), and renew when under 10 minutes remain.
- **Effort** - S
- **Test to add** - `fence.test.ts`: a mutate that throws `CloudflareReauthorizationRequired` ends `rejected` and releases the lock.

#### M10. The Reading library CI job hangs for 15 minutes when a browser fails to launch

- **Severity** - Medium
- **Dimension** - Performance and speed
- **Confidence** - Confirmed (run 40207401765: failures by 15:37:50, cancelled at the 15-minute limit at 15:51:09)
- **Evidence** - In `tests/browser/reading/reading-browser-test.mjs:934-935` the preview server starts listening and then `engine.launch()` runs outside the `try`, so a launch failure never closes the server (`:959`) and the process never exits. The other files in that group never run and no diagnostics upload.
- **Proposed fix** - `let browser; try { browser = await engine.launch(); ... } finally { await browser?.close(); await new Promise(r => server.close(r)); }`. Optionally add `--test-force-exit` to the `test:reading-browser:*` scripts.
- **Effort** - S
- **Test to add** - `PLAYWRIGHT_BROWSERS_PATH=/nonexistent node --test tests/browser/reading/reading-browser-test.mjs` exits with failures in seconds.

#### M11. Ungrouped Dependabot updates for the server and Actions each run the full 18-job matrix

- **Severity** - Medium (CI queueing)
- **Dimension** - Performance and speed
- **Confidence** - Confirmed
- **Evidence** - `.github/dependabot.yml:14-27` has no `groups` for `/packages/server` and `github-actions`. From 09-25 to 10-25, 44 of 299 "Node.js build" runs came from those two ecosystems (eight open PRs now). Each occupies 4 of the 5 concurrent macOS slots; the last green master run waited 80-98 minutes behind Dependabot runs.
- **Proposed fix** - Add `groups: { server: { patterns: ["*"] } }` and `groups: { actions: { patterns: ["*"] } }`. Tradeoff: one bad bump blocks its group until excluded.
- **Effort** - S
- **Test to add** - At most one open Dependabot PR per grouped ecosystem.

### Low

#### L1. Typed-time recurrences still drift across DST (first-pass F3, second half)

- **Severity** - Low (the editor never produces this pair; legacy, hand-edited or API data only)
- **Dimension** - Robustness
- **Confidence** - Confirmed (reproduced: a daily 02:30 Europe/Berlin reminder becomes 03:30 on 2027-03-28 and stays)
- **Evidence** - 3b439abc anchors the monthly day, but `applyRuleTime` (`src/reminders/core/recurrence/recurrenceCalculator.ts:175-187`) still takes the time from the current occurrence when the rule has no hour.
- **Proposed fix** - Pin `hour`/`minute` for timed dues in the same anchor helper that pins `dayOfMonth`.
- **Effort** - S
- **Test to add** - The Berlin 02:30 case across the March change returns to 02:30.

#### L2. Reading stops sending at the first rejected change

- **Severity** - Low
- **Dimension** - Robustness
- **Confidence** - Confirmed
- **Evidence** - `drainReading` always `break`s after a failure (`src/pwa/reading/outbox.ts:124`), including definite 400/409/410/413 rejections, so later independent captures wait for the next foreground or edit; no retry timer covers them (`src/pwa/reading/useReadingSync.ts:87-96`). Dependent edits are already marked for review (`outbox.ts:116-121`) and skipped (`:92-93`).
- **Proposed fix** - `continue` when `failed.review` is set; `break` only for transient failures.
- **Effort** - S
- **Test to add** - Change `src/pwa/reading/outbox.test.ts:110-127` to expect `other` sent in the first drain.

#### L3. Committing a Reading folder hard-codes `enabled: true` and can undo a pause

- **Severity** - Low
- **Dimension** - Robustness
- **Confidence** - Confirmed code path; outcome depends on timing
- **Evidence** - `src/reading/ui/plugin/settings-section.ts:33` builds `{ enabled: true, folderPath }`, awaits up to three policy requests, then writes it (`:47`) unserialized with `setSharedFeature`. Selecting **Enable reading** blurs the folder field, which starts the commit; a pause from this or another device can be undone locally for up to 10 minutes.
- **Proposed fix** - Build `{ ...plugin.settings.reading, folderPath }` right before `writeSettings`, after the awaits.
- **Effort** - S
- **Test to add** - Hold `readReadingPolicy` open, pause Reading, release: `settings.reading.enabled` stays false.

#### L4. Worker Reading writes strip a note's UTF-8 BOM (regression from ee25ad24)

- **Severity** - Low
- **Dimension** - Robustness
- **Confidence** - Confirmed (temporary test)
- **Evidence** - `src/cloudflare/worker/reading/common.ts:44` decodes with `new TextDecoder('utf-8', { fatal: true })`, which strips the BOM. Before ee25ad24 such notes failed and were never written; now updates, retries (`reading/mutations.ts:85,89-90`) and extraction (`extraction/jobs.ts:41-49`) commit them without it, while `src/reading/core/frontmatter.ts:6,29` deliberately keeps a BOM.
- **Proposed fix** - Add `ignoreBOM: true`, matching `decodeMarkdownBytes`.
- **Effort** - S
- **Test to add** - `projection-recovery.integration.ts`: `update` on the BOM note keeps the leading `EF BB BF`.

#### L5. Device-local history checkpoints can no longer be created

- **Severity** - Low
- **Dimension** - Simplification
- **Confidence** - Confirmed
- **Evidence** - `SharedHistoryApi.save()` returns a checkpoint or throws (`src/sync/worker-api/history-checkpoints.ts:14-18`). `saveShared` returns `undefined` only under the same guard that makes `saveLocal` return `undefined` (`src/sync/engine/history.ts:35-44`), so the fallback at `src/sync/runtime/runtime.ts:598-601` never saves anything. Vaults above the shared limits (100k files or 32 MiB) now get no checkpoint at all; e01149ed optimized a preview path that only legacy checkpoints reach.
- **Proposed fix** - Delete the local save fallback now; delete local load, compare and restore once legacy history entries age out. State in `docs/sync-pipeline.md` that vaults above the limits have no checkpoints.
- **Effort** - S
- **Test to add** - None for the deletion.

#### L6. Saved Cloudflare management tokens survive **Delete server and all data**

- **Severity** - Low (least privilege)
- **Dimension** - Robustness
- **Confidence** - Confirmed
- **Evidence** - `src/cloudflare/usage/connection.ts:173-185` stores account-wide access and refresh tokens under `crate-usage-oauth-<account>`. Deletion clears `cloudflareDeployment` (`src/cloudflare/deployment/service.ts:280`) but never revokes or clears the secret, and no UI reaches it afterwards.
- **Proposed fix** - On a `deleted` result, revoke both tokens best effort and store `''`, which `read()` already treats as absent. About 10 lines.
- **Effort** - S
- **Test to add** - `connection.test.ts`: `forget` sends two revoke requests, then `connected === false`.

#### L7. HTML charset decoding is duplicated, ignores `<meta charset>`, and throws on unknown labels

- **Severity** - Low
- **Dimension** - Robustness
- **Confidence** - Confirmed by code
- **Evidence** - The same two lines live in `src/reading/extraction/desktop-capture.ts:49-50` and `src/cloudflare/worker/reading/extraction/transport.ts:51-52`. Pages declaring a legacy encoding only in markup are saved garbled, and `charset=bogus` throws a `RangeError` that surfaces as a capture failure.
- **Proposed fix** - One `decodeHtml(bytes, contentType)` in `src/reading/extraction/` that falls back to UTF-8 for unknown labels and prescans the first 1 KB for `meta charset`; both hosts call it.
- **Effort** - S
- **Test to add** - Windows-1252 bytes declared only in `<meta charset>` decode correctly; `charset=bogus` decodes as UTF-8.

#### L8. Restore backup lists the entire R2 bucket to find upgrade backups

- **Severity** - Low
- **Dimension** - Performance and speed
- **Confidence** - Confirmed
- **Evidence** - `src/cloudflare/restore/server-restore.ts:12-24` pages through every object with no prefix (`src/cloudflare/cloudflare-api.ts:201-203`): about 100 sequential REST calls for a 100k-object vault, while `server-release.json` has no migrations, so no backup can exist yet.
- **Proposed fix** - Pass `prefix=__crate__/backups/schema-upgrade-`.
- **Effort** - S
- **Test to add** - `server-restore.test.ts`: one listing call with the prefix.

#### L9. Doc drift

- **Severity** - Low
- **Dimension** - Code quality
- **Confidence** - Confirmed
- **Evidence** - `docs/worker-api.md:573` says up to 100 revisions per metadata request (`ENCRYPTION_METADATA_BATCH = 1000`, `src/protocol/sync-limits.ts:37`); `docs/protocol.md:45` says the notification outbox sends up to five (`OUTBOX_BATCH_SIZE = 10`, `src/cloudflare/worker/notifications/outbox.ts:22`); `tests/editor-contract/README.md:10` names `typecheck:editor-contract`, removed in 47ff1093; the move-recovery notice still says "reload Crate to retry recovery" although recovery now retries after every sync (54398905).
- **Proposed fix** - Edit the four texts.
- **Effort** - S
- **Test to add** - None.

### Gaps in the first pass's fixes

Covered above where they matter (M1, H6, H5, L1, M6, L4). The rest:

| Commit | Gap |
| --- | --- |
| 4d7e72ee (coordinator wake) | `GET /reading/list` (including its 304 path) and `/reading/item` still wake notification processing, up to 11 wakes per foreground refresh, each resetting the 8-failure backoff. Wake only when `projectReading` actually ran a pass. |
| 9a4d9d8a (Reading re-projection) | Writes inside the folder still re-project the whole folder (H5), and the list ETag still uses the vault-wide token (`reading/queries.ts:26-32`). |
| a385651e (server picker) | Left a rejecting `selectDeployment` stub and four default parameters (`plugin/cloudflare-operations.ts:55-56`, `deployment/service.ts:42,90,108,122,262`) instead of a required parameter. |
| a3c4269c (tunnel rate limit) | Correct for managed tunnels; `--local` setups behind a reverse proxy still share one bucket. |
| 2f3feacc (persisted reminder index) | Rewrites the sealed index after every non-304 list even when unchanged. |

## 4. Simplification candidates

| Path(s) | What to delete or merge | Est. lines removed | Why safe |
| --- | --- | --- | --- |
| `src/cloudflare/usage/connection.ts:60-114`, `src/plugin/cloudflare-operations.ts:113-122` | `connect`, `handleCallback`, `pending` and the `usage-` callback branch | ~70 | `connect()` has no production caller, so a `usage-` state is never issued |
| `src/cloudflare/worker/sync/file-handlers.ts:188-237`, `routes/sync.ts:75`, `routes/policy.ts:72`, `docs/worker-api.md:35` | `POST /sync/delete` (move about 10 integration tests to batch delete) | ~55 | No client since 7fa6720a; confirm 0.8.0's `deleteFile` was unreachable before removing (`docs/compatibility.md`) |
| `src/cloudflare/worker/sync/file-handlers.ts:80-89`, `sync/batch/upload.ts:51-66`, `file-versions/handlers.ts:73`, `encryption/encrypted-folder-files.ts:123`, `staged-upload-dispatch.ts:18,63,104`, `sync/storage.ts:56-66` | `previousFile` in `StagedFileCommitInput`/`UploadMetadata` and its pre-commit reads; `collectCleanupKeys` becomes a `!==` | ~45, plus one D1 query per single upload, restore and encrypted commit | After 042b3e69 only the sealed-note check reads it, and every sealed caller passes `null` |
| `src/ui/activity/activity-modal.ts:31-52`, `panels.ts:37-51` | Make `ActivityModalDeps` required; drop `!` fallbacks and the micro-card branch | ~45 | All four production callers pass `plugin.syncRuntime` (still open from the first pass) |
| `scripts/pwa-startup-assets.mjs:13-25,27,35`, `pwa-client-build.mjs:3,45`, `build-worker.mjs:35,59,74,83,86,115`, `worker/pwa/client-bundle.ts:3,8-10`, `worker/pwa/service-worker.ts:3,10`, `tests/browser/support/preview/pwa-preview-assets.mjs:64`, `src/pwa/pwa-startup-assets.test.ts:25-40` | On-demand PWA asset code (keep `getPwaStartupAssets`) | ~40 | Always empty since 926f59e3 moved extraction to the server; reverting 7a6b817a would not bring it back |
| `src/sync/runtime/runtime.ts:598-601`, `engine/engine.ts:310`, `engine/history.ts:39-45`, `history/checkpoint.ts:27-37` | Local checkpoint save fallback | ~25 | Unreachable (L5) |
| `scripts/bundle-budgets.mjs:69-89`, `check-bundle-size.mjs:21,25-27,29,49` | Startup-assets budget row | ~25 | Same limit and same measurement as the all-assets row |
| `src/plugin/cloudflare-operations.ts:55-56`, `src/cloudflare/deployment/service.ts:42,90,108,122,262` | Rejecting `selectDeployment` stub; make the parameter required | ~8 | Every call passes `progress.selectVault` |
| `src/sync/transfer/upload.ts:153-155`, `upload-pipeline.ts:9,35`, `planner/incremental.ts:23,140` | Test-only `concurrency`, `batchConcurrency` and `uploadConcurrency` options | ~8 | No production caller passes them (still open from the first pass) |
| `src/sync/worker-api/http.ts:40-55` | Field-by-field response remap | ~6 | M8 |
| `src/pwa/reading/useReadingSync.ts:44-45`, `outbox.ts:81` | Second `/reading/session` fetch per refresh with pending work | ~5 | Pass the refresh's result to the drain |
| `src/cloudflare/worker/notifications/outbox.ts:34` | Rewrite of unchanged cancel rows | 0 (one predicate) | H4 |
| `src/ui/settings/encryption/encryption-section.ts:160-168` | Unreachable `keys` branches of `status()`, including stale "web apps use the same recovery key" copy | ~3 | The only call passes `null` |
| `src/protocol/sync-limits.ts:10`, `src/protocol/server-info.ts:36` | `BATCH_ASSET_UPLOAD_CAPABILITY` | ~3 | No protocol 1 client checks it |
| `src/reading/core/notes.ts:63-66` | Second `parseReadingNote` in `recordMarkdownHighlights` | ~3 | The library already parsed it; saves a full render per record |
| `src/reading/core/duplicates.ts:32-33` | Per-highlight `readingDocument` calls inside `.map` | ~2 | Hoist two `.text` computations; about 1.7 s of main-thread work for 100 highlights on desktop |
| `src/reading/runtime.ts:119`, `data/library.ts:77-79` | `library.invalidate(path)` from `changed()`; `invalidate` becomes `cache.delete` | ~2 | The revision includes a per-file event counter; removes O(library) work per event |
| `src/pwa/reminders/encrypted-reminder-attempts.ts:78`, `src/pwa/reading/storage/cache.ts:26` | Hard-coded 100,000 limits; import each feature's bound | ~2 | The Reading one already drifted from the new 10,000 bound |
| `src/pwa/reminders/outbox/reminder-outbox.ts:101-102` | Unlocked discard branch; always discard under `withLock` | ~2 | Also closes a narrow cross-tab retry/discard race |
| `src/cloudflare/deployment/embedded-artifacts.ts:12,21` | Module-level `decodedArtifacts` cache | 2 | Keeps about 4 MB of Worker source in memory after a rare update, reset or restore |
| `src/sync/history/restore.ts:93` | First `await verify()` in `restore()` | 1 | Staging hash-checks each file and the second `verify()` (`:119`) re-checks both inventories; saves one full-vault read and hash pass plus a manifest fetch per restore |
| `.github/workflows/pages.yml:109,123-124` | `security:check` step and full-history checkout | 3 | The same check runs in `verify.yml`; `site-deployment.mjs:49` needs only `rev-parse HEAD` |

## 5. Things that are good

Keep these; they are load-bearing and easy to "simplify" by mistake.

- **Shared reminder core with parity tests.** Plugin, PWA and Worker build lists, mutations and recurrences from `src/reminders/core/`; the import graph shows no host-specific copies. Persisted parsing uses a fixed reference date and a bounded two-generation cache, so the same line always parses the same way.
- **Upload journal and receipts.** An identical retry reuses the pending operation (`sync/durability/upload-journal.ts:69-76`); retention after 042b3e69 uses exactly the upload's own `UPDATE` condition in the same batch.
- **Atomic local apply and trash-only deletes.** Comparisons run inside `Vault.process` (`sync/local/local-apply.ts:229-240`) and local deletes check stat identity before trashing (`local-delete.ts:60-89`).
- **Order-independent text merge.** Same-point insertions are ordered by content (`sync/merge/text-merge.ts:44-55`) and the output is re-checked against authored inputs for code blocks and frontmatter.
- **Strict wire validation.** Manifest and changelog pages require monotonic sequences and non-empty `hasMore` pages (`sync/worker-api/read-contracts.ts`); encryption formats require canonical base64url, exact headers and bounded sizes before JOSE runs.
- **Encryption reset begin is one transaction.** Replacement credential, receipt, device revocation and Reading wipe commit together, so a lost reply is safe to retry; the reset cleanup Worker re-checks lock ownership before each R2 delete.
- **PWA reviewed removal.** Removal compares the exact export under the same lock used for sending, and `capturePwaSession` is checked right before every durable write, so a late write cannot undo another tab's logout. The persisted encrypted reminder index is sealed and bound to build, vault, key generation and folder.
- **Settings persistence.** Writes go through one ordered queue and publish only the fields each write owns (`plugin/settings-persistence.ts`); diagnostics export picks safe fields explicitly.
- **Build and CI.** Verified prebuilt Worker reuse under `CRATE_WORKER_PREBUILT`, one budget source, release reuse of the exact-commit run, and a `test:ci` guard that keeps the Playwright container image in step with the lockfile (`scripts/browser-tests.test.mjs:133-139`).

## 6. Not checked

- **Suites not run:** `test:worker-runtime`, browser, visual and editor-contract suites (outside the allowed command list or needing devices). C1, H4 and H5's D1 row counts come from code paths and SQLite query plans, not metered `rows_read`.
- **Master CI at `fd2f83ca`:** the "Node.js build" run was still in progress while writing; its visual, PWA browser, editor-contract and Reading jobs had already failed, and their logs were not yet available. Root causes for those jobs are not established here.
- **Local environment:** this worktree's `node_modules` was installed on Oct 11 (Vitest 4.1.11, Playwright 1.63.0, nested htmlparser2 10.1.0) and did not match the lockfile. The checks above were rerun after `npm ci`; npm held back the `esbuild`, `workerd` and `@parcel/watcher` install scripts pending approval, which did not affect these checks but may affect `test:worker-runtime`.
- **Needs a real Obsidian or device:** `requestUrl` getter behavior (M8), startup walk timings (M7), Activity list DOM timings (M4), popout windows after 52f578cd, mobile cold start of the 1.8 MB PWA startup bundle.
- **Plausible issues left out until measured or confirmed:**
  - Clip adoption takes `saved_at` from the local file mtime when the clip has none (`src/reading/data/library.ts:103`, `src/reading/core/notes.ts:90`), so two devices adopting the same raw clip can write different bytes and create a conflict.
  - Shadow mount theme observers disconnect only on the next body class change (`src/ui/plugin/shadowReactMount.ts:47-51`); a heap snapshot after 20 editor opens would show whether detached trees accumulate.
  - Worker-runtime tests spend about 323 of 365 s on imports, each of 95 files loading the 3.9 MB `worker.mjs`.
  - macOS PWA shard 2 used 1,046 s of its 1,200 s timeout with two retries.
- **Areas only skimmed:** encryption address workflow, `server-reset/delete*.ts`, `packages/server` backup and restore (no migrations exist yet, so the upgrade path is untested in practice), Lexical editor behavior with IME and paste, PWA navigation and sheet hooks.
- **Leads dropped after checking:** per-vault `secretStorage` (tokens are scoped by a deployment hash, so a shared `crate-device-id` matters only for two vaults on one server); `localeCompare` in the reminder receipt hash (computed only in the Worker over fixed ASCII keys); reminder index cost per event (1.9 ms per changed note at 5,000 reminders); unmemoized PWA connection context (views are already memoized); encryption-reset completion as one D1 batch (atomic, cheap to retry, under the statement limit); an encrypted remote delete loss for files uploaded mid-session (the device's own changelog echo teaches the path index before the delete is read).
