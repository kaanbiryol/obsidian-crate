# Engineering audit - 2026-10-25

Scope: plugin (`src/sync`, `src/protocol`, `src/plugin`, `src/ui`, `src/encryption`, `src/reminders`, `src/reading`), Worker and plugin-side Cloudflare code (`src/cloudflare`), the PWA (`src/pwa`), `packages/server`, and build/CI tooling. Audited at `33b27c74`. Six area audits ran in parallel; the lead re-read every cited location and its callers and reran the reproductions before including a finding.

Checks run on this commit: `npm run lint` (0 errors, 3 warnings), `typecheck`, `typecheck:worker`, `typecheck:service-worker`, `deadcode`, `build:worker`, `build:plugin` and `size-check` all pass. `npm test`: 8 of 5,376 tests fail, all in `src/cloudflare/worker/pwa/index.test.ts` (see F10). Worker-runtime, browser and visual suites were not run.

## 1. Summary

- The core data-safety design is strong: durable upload journals with server receipts, revision-guarded deletes, trash-only local deletes, checkpoint generations, and D1 transactions that write receipts with the CAS. Most findings sit at the edges of these mechanisms, not in them.
- The one Critical issue is in force full sync: an interrupted run persists a cleared, partial checkpoint even though the docs promise the previous manifest is restored (F1). It reproduces through the real persistent engine harness.
- Several "stuck forever" states share a pattern: a record that needs review blocks progress and has no exit. Binary incoming reviews fail and re-download every sync (F8); PWA outbox entries that cannot settle block every PWA update for up to 180 days or until logout (F4); a move-journal record re-posts a sticky notice on every sync (F11).
- Shared settings promised as "All devices" are only read at connect time, so exclusion lists diverge across connected devices (F2).
- Reminder rules are genuinely shared across plugin, PWA and Worker, which is good, but that also means a shared bug ships everywhere: typed "every month" reminders drift to the 28th permanently (F3).
- The Worker's Reading projection is the main D1 scalability risk: any vault write invalidates it, one mis-encoded note makes it permanently unavailable, and coordinator routes re-arm it on reads (F6, F7, F12, F13). On the Free plan these can plausibly exhaust the daily D1 read allowance.
- Encryption: the setup link puts the permanent whole-vault recovery key in a URL fragment, while the consent copy says web apps can read only two folders (F5).
- Size budgets are effectively full: `main.js`, the Worker and the PWA all sit at 99% of their budgets, and a duplicated HTML parser accounts for most of the available headroom (F18).
- CI on `master` has no green signal: Linux browser jobs use a Playwright image one minor version behind the lockfile, and 8 unit tests assert CSS removed by recent design commits (F10). CI also does avoidable duplicate work (F19).

## 2. Top 10

Ranked by impact divided by effort.

| Rank | Finding | Severity | Effort |
| --- | --- | --- | --- |
| 1 | F1 - Interrupted force full sync persists a cleared, partial checkpoint | Critical | S |
| 2 | F3 - Typed monthly recurrences drift to the 28th; typed times drift across DST | High | S |
| 3 | F6 - One badly encoded Reading note returns 503 for the whole library | High | S |
| 4 | F8 - A pending incoming binary review re-downloads the file and fails every sync | High | S |
| 5 | F5 - Encrypted setup links carry the whole-vault recovery key; consent copy says folder-only | High | S |
| 6 | F10 - Master CI has no green signal (stale Playwright image, 8 stale unit tests) | High | S |
| 7 | F4 - PWA outbox entries that cannot settle have no reviewed exit and block PWA updates | High | S-M |
| 8 | F7 - Any vault write re-projects the entire Reading folder | High | S-M |
| 9 | F2 - Shared "All devices" settings never reach already connected devices | High | M |
| 10 | F9 - Encrypted Reminders PWA downloads and decrypts every note after each cold start | High | M |

Close runners-up with one-line fixes: F14 (periodic check race), F12 (coordinator `wake` always true), F15 (preview fetches the whole manifest).

## 3. Findings by severity

### Critical

#### F1. Interrupted force full sync persists a cleared, partial checkpoint

- **Severity** - Critical (sync divergence; needs Stop, quit or crash during a force sync)
- **Dimension** - Robustness
- **Confidence** - Confirmed (reproduced through `createPersistentEngineHarness`: 200 tracked files plus one remote-only baseline, Stop after about 90 receipts; the reloaded checkpoint had 64 of 201 entries and no remote-only baseline)
- **Evidence**
  - `src/sync/engine/force-sync-workflow.ts:86` clears the manifest before uploading. `src/sync/durability/durable-uploads.ts:179-182` then saves that cleared manifest every 64 receipts.
  - On Stop, the runtime destroys the engine and `src/sync/manifest/manifest.ts:151` turns every later `save()` into a no-op once the manifest is closed. The restore in the `finally` block (`force-sync-workflow.ts:142-151`) therefore only restores memory. A crash or quit skips the `finally` block entirely, with the same on-disk result.
  - Next sync: force sync never advanced `lastSeq`, so it runs incrementally. Files missing from the checkpoint are re-uploaded with `expectedHash: null`, get 409s and rejection receipts, then go through reconciliation; edited ones become concurrent-create conflict copies. Remote-only files that the force sync meant to delete are not in the changelog, so this device never sees them until the cursor expires.
  - Contradicts `docs/sync-pipeline.md:100`: "the previous local manifest is restored".
- **Proposed fix** - Do not clear the manifest. Prepare each upload with `{ force: true, expectedHash: remote?.hash ?? null }`, and after the remote deletes succeed, `removeEntry` every manifest path that is not local. Delete `snapshotLocalManifest`, `clearLocalManifest`, `replaceLocalManifest` and the restore `finally` block (`contexts.ts:152-154`). This also removes a full `structuredClone` of the manifest. An interrupted run then leaves correct baselines for the files it did not reach. No protocol or checkpoint format change.
- **Effort** - S
- **Test to add** - Persistent engine test with more than 64 files: hang `/sync/batch-upload` after N receipts, `destroy()`, reload `LocalManifest`, and expect every baseline entry (including the remote-only one) to be present.

### High

#### F2. Shared "All devices" settings never reach already connected devices

- **Severity** - High (settings divergence that changes what each device syncs)
- **Dimension** - Robustness
- **Confidence** - Confirmed
- **Evidence**
  - Shared settings are read only at connect time: `src/plugin/cloudflare-connection.ts:28-31` and `src/plugin/self-hosted-connection.ts:83-84`. Both skip the read for encrypted vaults and nothing reads them after unlock.
  - The only other path is the push on settings close, which returns before any server read when this device changed nothing (`src/ui/settings/shared-settings-push.ts:28-32`).
  - No sync, startup or periodic path calls `/settings` (`rg getSharedSettings` outside the Worker finds only the two connect paths and the push).
  - The UI says "All devices" (`src/ui/settings/exclusions-setting.ts:18`, `src/ui/settings/sync-interval.ts:16`) and the user docs say shared changes reach other connected devices (`docs-site/src/content/docs/features/settings.md:54`).
  - Failure: device A adds `Journal/` to exclusions. Device B keeps syncing `Journal/` indefinitely, and the reverse holds when an exclusion is removed. B converges only if it edits a shared setting itself or reconnects.
- **Proposed fix** - Keep one tracker per plugin (move it from the settings tab) and add `pull()`: `remote = getSharedSettings()`, `next = rebaseSharedSettings(base, local, remote)`, write and call `updateSyncSettings()` when `next` differs, then `base = remote`. Call it from the existing throttled shared-features refresh (`src/plugin/feature-settings.ts:63-81`), which already runs at startup and at most every 10 minutes. Unlocked encrypted vaults already decrypt through `SharedSettingsWorkerApi`. No format change.
- **Effort** - M
- **Test to add** - Worker-runtime test with two plugin runtimes: A pushes new `ignorePatterns`; after B's next refresh, B's settings match and B's next sync skips a file under the new exclusion. Repeat for an unlocked encrypted vault.

#### F3. Typed monthly recurrences drift to the 28th; typed times drift across DST

- **Severity** - High (wrong due dates and notifications on every host, permanently)
- **Dimension** - Robustness
- **Confidence** - Confirmed (reproduced through `resolveReminderSubmission`, `buildCreatedReminderBlock` and `setReminderCompletionInContent`)
- **Evidence**
  - "every month" parses to `{ frequency: 'monthly' }` with no `dayOfMonth` (`src/reminders/core/recurrence/recurrenceParser.ts:24,114-120`). `recurrenceCalculator.ts:44-49` then adds months to the current occurrence, which clamps and loses the anchor.
  - "Pay rent every month" created on 2027-01-31, completed three times: Jan 31 -> Feb 28 -> Mar 28 -> Apr 28.
  - Same root cause in `applyRuleTime` (`recurrenceCalculator.ts:175-187`): with no rule hour, the time comes from the current occurrence. A daily 02:30 Europe/Berlin reminder becomes 03:30 on 2027-03-28 and stays at 03:30.
  - The repeat picker always sets `dayOfMonth` and the hour (`recurrencePickerShared.ts:105-118`), so only typed grammar is affected. Because the rule is shared, plugin, PWA and Worker are consistently wrong rather than divergent.
- **Proposed fix** - Pin the anchor when a rule first meets a due date, in `buildCreatedReminderBlock`, `buildUpdatedReminderBlock` and `normalizeReminderScheduleLine`: `if (rule.frequency === 'monthly' && !rule.dayOfMonth && due) rule = { ...rule, dayOfMonth: fromDate(due, tz).day }` (day 31 already means month end). Pin `hour`/`minute` the same way for timed dues. The written rule becomes "monthly on the 31st", which released clients already parse.
- **Effort** - S
- **Test to add** - In `markdownReminderMutation.test.ts`, create "X every month" with now frozen at Jan 31, complete it three times and expect Feb 28, Mar 31, Apr 30. Add the daily 02:30 Berlin case across the March DST change.

#### F4. PWA outbox entries that cannot settle have no reviewed exit and block every PWA update

- **Severity** - High
- **Dimension** - Robustness
- **Confidence** - Confirmed
- **Evidence**
  - Reminders: a change whose response was lost, or which was in flight when the app was backgrounded, becomes `ambiguous` (`src/pwa/reminders/outbox/reminder-outbox.ts:131`). If the reminder is then edited in Obsidian, every exact-bytes retry returns 409. Since `definite = Rejected && !ambiguous` (`:147`), the change stays `uncertain`. `discard()` requires `status === 'failed'` and refuses ambiguous changes (`:92-97`), and the notice offers only Retry. The change clears only after the 180-day operation window expires and a manual retry returns 410 (`docs/reminder-retention.md`).
  - While stuck, the enqueue conflict rule (`:74-76`) blocks every reorder (or every mutation, if the stuck change is a reorder), and `hasUnsettledReminders()` makes `applyPwaUpdate` throw (`src/pwa/update/apply-update.ts:53`).
  - Reading: 400/409/410/413 set `review` (`src/pwa/reading/outbox.ts:95-107`); review ops never dispatch (`:29-31`) and nothing removes them. `hasUnsettledReading()` calls `hasEarlierReadingChanges()` with no session filter (`src/pwa/reading/update-guard.ts:6`, `storage/storage.ts:46-55`), so any review op, or any earlier-session queue (whose principal-bound receipts can never settle), blocks updates until logout, which discards all drafts and pending work.
- **Proposed fix** - Reuse the existing reviewed-removal flow. Reminders: let `discard` accept `reviewedChange` (exact JSON match, under the lock) for ambiguous changes whose status is not `pending`, and show the export/remove actions next to Retry. Reading: add `removeReviewedReading(session, opId, exportedJson)` under `readingLock` that removes the op and its dependent follow-ups only when the stored op still matches the export; do the same for an earlier-session `pending:<id>` key. No storage format change.
- **Effort** - S (reminders) + M (Reading)
- **Test to add** - Unit: lost response, then 409; plain discard is refused, reviewed discard removes it and `hasUnsettledReminders()` is false. Reading: update, 409, stale export refused, matching export removes it and `hasUnsettledReading()` is false. Browser: extend `pwa-update-test.mjs` so an update proceeds after removal.

#### F5. Encrypted setup links carry the whole-vault recovery key; consent copy says folder-only

- **Severity** - High (security; key rotation is not available, so a leak is permanent until a destructive reset)
- **Dimension** - Robustness
- **Confidence** - Confirmed for the key embedding and the copy. Persistence in browser history is Plausible (open a link on desktop Chrome and check `chrome://history`).
- **Evidence**
  - `src/ui/settings/reminders-web-app.ts:86-90` puts `crateKey` and `crateReadingKey` (the recovery key) in the fragment of every encrypted setup link. On desktop, `:31` passes it straight to `window.open`; only the QR dialog warns (`src/ui/qr-modal.ts:18-24`). The PWA's `replaceState` cleans the address bar, not the history database, history sync or clipboard managers.
  - The consent screen says web apps "can read entire notes in their connected Reading and Reminders folders" (`src/ui/settings/encryption/encryption-setup-ui.ts:79`). Since the single-key change (98c42be0), an unlocked web app can decrypt the whole vault (`docs/e2ee-implementation.md:21`). The comment at `src/encryption/local-state.ts:8` has the same stale model.
  - Pairing ("Connect with Obsidian") already unlocks web apps without transferring the recovery key and is the documented default.
- **Proposed fix** - Stop adding `crateKey` and `crateReadingKey` to the link (keep `crateFolder`); the PWA already handles a locked enrollment and offers pairing or the recovery key. Replace the consent bullet with: "Web apps you unlock receive the vault key, which can decrypt every synced note. Unlock only web apps you trust." Old links keep working.
- **Effort** - S
- **Test to add** - `reminders-web-app.test.ts`: the encrypted-vault URL contains no `crateKey`. `pwa-pairing-test.mjs` already covers locked-then-pair.

#### F6. One badly encoded Reading note returns 503 for the whole library

- **Severity** - High
- **Dimension** - Robustness
- **Confidence** - Confirmed for invalid UTF-8. Plausible for a BOM-prefixed note (depends on workerd's `text()` stripping the BOM, as the Fetch spec does).
- **Evidence**
  - `src/cloudflare/worker/reading/common.ts:41-42` decodes the R2 object with lossy `object.text()` and hashes the decoded string. For invalid UTF-8 the hash never matches `file.hash`, so `readSource` throws 503.
  - `reading/projection.ts:49-51` treats every non-413 failure as `unavailable`, writes no row, and never stores the completion token (`:73-75`). `reading/routes.ts:72` then returns 503 for every list and item request, with no per-file issue.
  - The coordinator re-arms every 30 s (`reading/extraction/jobs.ts:103`, `notifications/coordinator.ts:55-59`) and each pass re-runs the folder-wide queries from F7, for up to 24 h per episode; any Markdown upload or coordinated Reading GET restarts the episode (F12).
  - Contradicts `docs/worker-api.md:97-99` ("malformed or oversized notes instead produce stable source issues"). The reminders path does this correctly: it hashes raw bytes (`worker/storage.ts:68-69`) and decodes with `decodeMarkdownBytes`.
- **Proposed fix** - In `readSource`, read `arrayBuffer()`, compare `sha256Hex(bytes)` with the stored hash, then `decodeMarkdownBytes(bytes)`. In `projectReading`, record a `MarkdownEncodingError` as the row's `error`, as 413 already is. No schema or protocol change.
- **Effort** - S
- **Test to add** - Worker-runtime: a Reading-folder note with bytes `68 FF 69` (and a BOM case). Expect `projectReading` to return `complete`, `/reading/list` to return 200 with one issue, and no re-armed pass.

#### F7. Any vault write re-projects the entire Reading folder

- **Severity** - High (D1 read cost grows with library size on every synced save)
- **Dimension** - Scalability
- **Confidence** - Confirmed mechanism; row counts estimated from query shapes, not metered
- **Evidence**
  - `src/cloudflare/worker/reading/projection.ts:30-31` keys completion to `vaultChangeToken`, which hashes the vault-wide `MAX(seq)` (`src/cloudflare/worker/vault-change-token.ts:18-21`). Any write anywhere invalidates it.
  - The next pass runs the `DELETE ... path NOT IN (folder files)` and the folder `LEFT JOIN` scan (`projection.ts:33-40`), roughly 4R rows for a Reading folder of R notes, even if nothing in the folder changed. Every Markdown commit arms that pass (`sync/staging/staged-upload-dispatch.ts:105`), and every Reading GET runs it (`reading/routes.ts:72`).
  - Example: R = 10,000 (the size `reading/queries.ts:37` is designed for) is about 40k rows per synced note save anywhere in the vault; about 125 saves use the whole 5M/day Free-plan read allowance, after which every route returns 429.
- **Proposed fix** - Keep the reset, import and policy parts of the token but replace the vault-wide `seq` with a folder-scoped check: store the projected seq and test `SELECT 1 FROM changelog WHERE seq > ? AND path >= 'F/' AND path < 'F0' LIMIT 1` (a primary-key range that reads only new rows). Fall back to a full pass when the stored seq is below the changelog floor; `changedPathsSince` (`vault-change-token.ts:47-54`) already implements this for reminders. The value lives in `maintenance_state`, so no schema change.
- **Effort** - S-M
- **Test to add** - Worker-runtime: bring a 2,000-note Reading folder to `complete`, commit one `.md` outside it, meter `projectReading`, and assert fewer than 100 rows read.

#### F8. A pending incoming binary review re-downloads the file and fails every sync

- **Severity** - High
- **Dimension** - Performance and speed
- **Confidence** - Confirmed (reproduced: three syncs gave three batch downloads, `lastSeq` stuck, all three syncs failed)
- **Evidence**
  - For an existing non-text file, `src/sync/local/local-apply.ts:236-237` calls `preserveIncomingForReview`, which always throws (`:62`). `src/sync/transfer/download.ts:148-150` turns that into a deferral plus an error, so the cursor is held (`src/sync/planner/incremental.ts:170-172`).
  - The next periodic check sees `hasChanges` (`src/sync/engine/lifecycle.ts:125-140`), and focus events also trigger syncs. Each sync downloads the binary again (up to 25 MiB), re-hashes the saved copy, rewrites `conflicts.json` (`src/sync/conflict/store.ts:159-186`) and reports failure, until the user resolves the review.
- **Proposed fix** - Before dispatching a download, skip it when an active `incoming-review` record exists for the same path with `remoteHash === expectedRemoteHash` and its saved copy still exists; record the same issue instead (about 8 lines in `download.ts`). Holding the cursor stays as designed. Consider reporting this state as "waiting for your review" rather than a failed sync.
- **Effort** - S
- **Test to add** - Engine test: an incoming binary review followed by three syncs makes exactly one `/sync/batch-download` request.

#### F9. Encrypted Reminders PWA downloads and decrypts every note after each cold start

- **Severity** - High
- **Dimension** - Performance and speed
- **Confidence** - Confirmed code path; magnitude Plausible (depends on reminders folder size)
- **Evidence**
  - The per-revision `scanned` cache lives only in memory (`src/pwa/reminders/encrypted-reminder-api.ts:44-47`) and the instance is recreated when the connection prepares (`src/pwa/connection/api-fetch.ts:85`).
  - The list ETag uses the vault-wide changelog sequence (`src/cloudflare/worker/encryption/encrypted-folder-files.ts:50`), so any Obsidian edit defeats the 304 path.
  - The first refresh after launch therefore does one `GET /reminders/encrypted-file` plus decrypt and parse per note, 6 at a time (`encrypted-reminder-api.ts:129-143`). With 300 notes that is about 50 sequential rounds on mobile, during which edits are blocked (`usePwaStatus.ts:76`) and notification taps wait (`useLaunchReminderModal.ts:39`).
  - Reading already avoids this with a persisted, sealed index (`src/pwa/reading/storage/cache.ts:33-42`, `reading/encrypted-api.ts:105-108`).
- **Proposed fix** - Mirror Reading's `loadIndex`/`saveIndex`: after each successful list, persist `[...scanned.values()]` as one sealed value under a new key that old clients never read, and seed `scanned` from it on first use. Clear it on rebuild; logout already deletes the databases.
- **Effort** - M
- **Test to add** - Unit test with a fake fetch: list, recreate the API from the saved index, bump the sequence and change one file, and assert exactly one `encrypted-file` request.

#### F10. Master CI has no green signal

- **Severity** - High (no release gate signal; every browser job burns runner time)
- **Dimension** - Code quality
- **Confidence** - Confirmed for the unit tests (run locally) and the version mismatch. Plausible that the mismatch is what fails the Linux browser jobs (one shard log would confirm it).
- **Evidence**
  - `npm test` fails 8 tests in `src/cloudflare/worker/pwa/index.test.ts`. Correction found while fixing: the main cause is `scripts/vite/raw-css-vite-plugin.mjs`, whose virtual ids end in `.scss`, so the CSS pipeline in Vitest 5 and Vite 8.3 replaces their string export (empty shell styles in tests; a Sass error in the `scripts/visual-preview.test.mjs` tooling test). Three of the 8 tests also assert CSS that 4874a023 ("use a monochrome accent in the pwa") and later design commits changed.
  - Linux browser jobs run in `mcr.microsoft.com/playwright:v1.63.0-noble` (`.github/workflows/verify.yml:180,265,314,384`) while the lockfile installs Playwright 1.64.1 (bumped in 4c51ff48). Every Linux browser shard and editor-contract shard failed in recent runs, while the macOS jobs that run `playwright install` passed. The last green "Node.js build" run predates the bump.
- **Proposed fix** - End the raw CSS virtual ids with a script extension, and update the three stale expectations in `index.test.ts`. Bump the image tag and digest to v1.64.1, and add a few lines to an existing `test:ci` test that assert every `playwright:vX.Y.Z` image matches the installed `playwright` version (Dependabot bumps the package but never `container.image`).
- **Effort** - S
- **Test to add** - The `test:ci` version assertion; the next run's Linux shards go green.

### Medium

#### F11. An unresolvable reminder move record re-posts a sticky notice and rescans reminders on every sync state change

- **Severity** - Medium
- **Dimension** - Robustness
- **Confidence** - Confirmed
- **Evidence** - `src/reminders/runtime.ts:81-93` runs `journal.recover()` and a full `index.load()` on every non-`syncing` state emission while `journal.hasPending()` is true. A record that needs manual review stays pending (`reminder-move-journal.ts:103-121`), as does unreadable storage (`unknown = true`). Each recovery posts `new Notice(..., 0)`, which never auto-dismisses (`runtime.ts:40-44`). The sync runtime emits state several times per sync, so the user collects a new permanent notice and a full sequential reminder-folder parse per emission. The notice itself says "reload Crate to retry recovery".
- **Proposed fix** - Delete `await index.load()` at `runtime.ts:88`; `index.flushDeferredScans()` on the next line already reloads when a load was deferred. Post the notice only when its text differs from the last one reported.
- **Effort** - S
- **Test to add** - In `plugin-integration.test.ts`, keep a pending move that returns the same issue, fire the state listener three times, and assert one Notice and no extra `index.load()` calls.

#### F12. Coordinator `wake` is always true: read routes and settings arm notification passes and reset the failure backoff

- **Severity** - Medium
- **Dimension** - Performance and speed
- **Confidence** - Confirmed mechanism; latency impact Plausible
- **Evidence**
  - `src/cloudflare/worker/routes/policy.ts:15` defines the only coordinator execution with `wake: true`, so `request-handler.ts:144` arms the coordinator for every coordinated route, including `GET /reading/list|item|session|encryption|encrypted-files|encrypted-file|policy`, `GET /encryption/reset`, `PUT /settings` and `DELETE /auth/tokens`.
  - Each arm resets `{ passes, failures, startedAt }` (`notifications/lifecycle.ts:11-15`), defeating the eight-failure backoff, and triggers a pass of about 15 D1 queries under the lock. It also restarts the F6 retry episode.
  - `GET /reading/encrypted-file(s)` do no writes but are serialized through the single coordinator, while the identical Reminders routes are not (`policy.ts:34-35` versus `:38-39`).
  - Contradicts `docs/notification-processing.md:3` ("Settings ... do not wake notification processing").
- **Proposed fix** - Add `const COORDINATOR_READ = { kind: 'coordinator', wake: false }` for the GET routes and `PUT /settings`, and drop coordinator execution for the encrypted Reading reads and `/reading/encryption`. Plaintext Reading GETs still need the lock to project. Fix the doc sentence: deletes and restores do enqueue projection (`sync/mutations.ts:202`) and need their wake.
- **Effort** - S
- **Test to add** - Worker-runtime: `GET /reading/list` through the coordinator sets no alarm and leaves the `notificationRun` key unchanged.

#### F13. The Reading PWA probes `/reading/encryption` before every request in unencrypted vaults

- **Severity** - Medium
- **Dimension** - Performance and speed
- **Confidence** - Confirmed
- **Evidence** - A `null` verdict clears `pending` (`src/pwa/reading/session/encryption-session.ts:81`), and every request calls `prepareReadingEncryption` first (`src/pwa/reading/api.ts:66-68`). That doubles the requests for each list page, article open, prefetch (up to 10 per refresh) and drain call, and each probe is a coordinator Durable Object round trip (`policy.ts:37`). The Worker already returns 428 for plaintext Reading routes when encryption is on (`worker/reading/routes.ts:36`) and the client already re-probes on 428 (`api.ts:60-65`). Reminders skips the probe based on a response header (`src/pwa/connection/api-fetch.ts:80`).
- **Proposed fix** - Keep a `null` verdict for GETs and force a fresh probe only before sending a POST body while no keys are loaded. This keeps "verify before sending plaintext bodies".
- **Effort** - S
- **Test to add** - Unit: count `/reading/encryption` fetches over two list pages and three article loads; expect one. A 428 still triggers a probe.

#### F14. A periodic check overlapping a queue flush records a failed sync and backs off

- **Severity** - Medium
- **Dimension** - Robustness
- **Confidence** - Confirmed (reproduced at the lifecycle level)
- **Evidence** - `src/sync/engine/lifecycle.ts:109` checks `syncing` once, then awaits the network and an optional vault scan (`:125-129`) before calling `sync()`. If a debounced flush starts in that window, `src/sync/sync-outcome.ts:29` returns "Sync already in progress" as a failed result, which is written to history and persisted (`engine.ts:133-136`, `runtime.ts:618-620`) and increments the backoff (`lifecycle.ts:143`). If it becomes the newest history entry, the next startup begins in `error` state (`engine.ts:104-115`).
- **Proposed fix** - At `lifecycle.ts:138`, add `if (dependencies.getStatus() === 'syncing') return;`.
- **Effort** - S
- **Test to add** - Lifecycle unit test where `checkForChanges` flips the status to `syncing`: `sync` is not called and `checkFailureCount` stays 0.

#### F15. Local-checkpoint file previews download the whole remote manifest per file

- **Severity** - Medium
- **Dimension** - Scalability
- **Confidence** - Confirmed
- **Evidence** - `src/sync/engine/history.ts:59` calls `(await context.api.getManifest()).files[path]` on every preview read: all manifest pages plus a changelog replay, and in encrypted vaults every descriptor through `/encryption/metadata`. Local checkpoints are used when the server refuses a shared one, which happens above 100k files or 32 MiB (`docs/sync-pipeline.md:411`), so the largest vaults get this path. At 100k files that is about 50 requests and 100k D1 rows per file selected. The equivalent loaders already use a single lookup (`src/sync/pending/pending-baseline.ts:16`, `src/sync/history/file-history-preview.ts:53`).
- **Proposed fix** - `(await context.api.getFileMetadata([path])).files[path]`.
- **Effort** - S
- **Test to add** - Preview two files of a local-checkpoint comparison and assert zero `/sync/manifest` requests.

#### F16. Self-hosted tunnels put every client in one 60-per-minute admission bucket

- **Severity** - Medium (availability, self-hosted only)
- **Dimension** - Robustness
- **Confidence** - Confirmed for the shared key; transfer-shard amplification Plausible
- **Evidence** - The gateway strips `cf-*` headers and sets `CF-Connecting-IP` to the socket address (`packages/server/src/local-server-http.mjs:36-41`). The managed tunnels connect from 127.0.0.1 (`local-server-quick.mjs:27`, `local-server-tunnel.mjs:145`), so `api-admission:<host>:sha(127.0.0.1)` (`src/cloudflare/worker/rate-limit.ts:34-41`) is one global key limited to 60 per 60 s. Anyone who knows the tunnel URL can send 60 junk-bearer requests per minute and block enrollment exchange, subscribe, Reading captures and shortcut exchange, plus any credential whose 60 s admission hint has lapsed. Contradicts `docs/worker-api.md:541-545` ("per hashed source address").
- **Proposed fix** - In managed-tunnel modes, for loopback peers, forward the `cf-connecting-ip` that `cloudflared` sets instead of the socket address. Optionally skip the anonymous limiter for `execution.kind === 'transfer'`, which reauthenticates anyway. Tradeoff: trusting that header from local processes; enable it only for the managed tunnel.
- **Effort** - S
- **Test to add** - Gateway unit test for the forwarded address in tunnel mode; Worker-runtime test sending 60 invalid-token requests, then a valid enrollment exchange that succeeds.

#### F17. The Live Preview reminders extension cannot render and is about 400 dead lines

- **Severity** - Medium
- **Dimension** - Simplification
- **Confidence** - Confirmed that it cannot render; Plausible that it never matches (open a reminders block in Live Preview: `.reminders-block-widget` absent, `.block-language-reminders` present)
- **Evidence** - `src/reminders/query/remindersBlockLivePreview.tsx:282-285` emits `Decoration.replace({ widget, block: true })` from a `ViewPlugin`. CodeMirror rejects that with "Block decorations may not be specified via plugins" (`node_modules/@codemirror/view/dist/index.js:2772-2775`), and Obsidian ships the same check. Obsidian's Live Preview tree also tokenizes code fences per line, so `extractRemindersBlockInfo` likely returns null and the code never reaches the throw. The registered `registerMarkdownCodeBlockProcessor` handlers already render these blocks in Live Preview. The unit test mocks `EditorView`, so it cannot catch this.
- **Proposed fix** - Delete the extension, its test, `query/editorFile.ts`, `extractRemindersBlockInfo`/`isRemindersBlockStart` in `remindersBlockOptions.ts`, and the registration at `src/reminders/register-integrations.ts:37-41`. Then confirm the completed toggle persists in Live Preview through `ctx.getSectionInfo` (`injector.tsx:29`).
- **Effort** - S
- **Test to add** - Manual Live Preview check above; no automated test needed.

#### F18. Duplicate htmlparser2/entities in `main.js` and the Worker while every bundle sits at 99% of budget

- **Severity** - Medium (budget risk blocks unrelated features)
- **Dimension** - Performance and speed
- **Confidence** - Confirmed duplication; savings measured standalone, not on a full rebuild
- **Evidence** - The direct dependency is `htmlparser2` 12.0.0 (`package.json:155`), but `linkedom` 0.18.13 requires ^10.1.0, so `node_modules/linkedom/node_modules/` carries a second htmlparser2, entities, domhandler and domutils, and both entities decode tables ship in `dist/main.js` and `.generated/cloudflare/worker.mjs`. Current `size-check`: `main.js` 4,807 / 4,855 KiB raw, Worker 3,956 / 3,989 KiB, PWA `app.js` 1,118 / 1,133 KiB, `styles.css` gzip within 0.4 KiB of its budget.
- **Proposed fix** - Add `"linkedom": { "htmlparser2": "$htmlparser2" }` to the existing `overrides` (linkedom only uses `new Parser(handlers, { xmlMode })`, unchanged in v12). Expected saving is about 60 KB raw in both the Worker and `main.js`, plus about 30 KB of the embedded Worker base64. Fallback: pin the direct dependency to 10.1.0. Run `npm run notices:generate` after the change.
- **Effort** - S
- **Test to add** - Reading extraction tests, `test:reading-server`, `size-check`, and a grep confirming one entities table per bundle.

#### F19. CI repeats work on every push

- **Severity** - Medium
- **Dimension** - Performance and speed
- **Confidence** - Confirmed
- **Evidence**
  - `lint.yml:3-7` and `security.yml:2-4` trigger on both `push: ["**"]` and `pull_request: ["**"]`, and the concurrency group includes `github.event_name`, so every Dependabot branch runs the full 18-job matrix twice (for example runs 40207124967 and 40207128262 on one SHA). Doubling exceeds the macOS concurrency limit; native PWA shards have queued 39-49 minutes.
  - Twelve browser jobs plus `visual.yml:29` run `npm run build`, which includes a full `tsc` already run by the checks job (`verify.yml:246,282,331,401`). One type error then fails every browser shard at the build step (runs 40201706309, 40190628574).
  - `security.yml:18` repeats the secret scan that `verify.yml:55-56` runs on the same events.
  - `pages.yml:96-97` uses a macOS runner for a plutil test that already runs on macOS in `verify.yml`.
- **Proposed fix** - `push: branches-ignore: ["dependabot/**"]` in `lint.yml` and `security.yml` (release reuse filters `event=push` on the exact SHA, never on Dependabot branches). Replace those `npm run build` lines with `npm run build:worker && npm run build:plugin`. Delete `security.yml` and split the verify security step into independent `security:audit` and `security:secrets` steps. Move `pages.yml` to `ubuntu-latest`.
- **Effort** - S
- **Test to add** - `gh run list` shows one run per Dependabot head SHA; a deliberate type error fails only the checks job.

#### F20. Shadow DOM views and code blocks likely fail in Obsidian popout windows

- **Severity** - Medium
- **Dimension** - Robustness
- **Confidence** - Plausible. Confirm in the Obsidian desktop console: `const w = window.open(''); const h = w.document.body.appendChild(w.document.createElement('div')); h.attachShadow({ mode: 'open' }).adoptedStyleSheets = [new CSSStyleSheet()]` should throw "Sharing constructed stylesheets in multiple documents is not allowed". Or drag the Reminders view into a new window.
- **Evidence** - `src/ui/plugin/shadowStyles.ts:11-17` builds one `CSSStyleSheet` per plugin from the main window's constructor and adopts it into every shadow root (`:23-29`), including roots in a popout's document. Callers include `src/reminders/query/injector.tsx:119`, `src/reminders/ui/plugin/reminders-view.tsx:57` and `src/reading/ui/plugin/reading-view.tsx:19`. `docs/ui-styling.md` claims popout support but notes popouts are untested. A rejected `adapter.read` also stays cached forever (`shadowStyles.ts:19`).
- **Proposed fix** - Cache the CSS text once per plugin (dropping it on read failure) and build one sheet per document with `new (doc.defaultView!.CSSStyleSheet)()`, held in a `WeakMap<Document, CSSStyleSheet>`.
- **Effort** - S
- **Test to add** - Chromium test mounting `createShadowReactMount` into a `window.open('')` document and asserting the styles apply.

#### F21. Browser-initiated service worker updates can bypass the PWA update gate

- **Severity** - Medium
- **Dimension** - Robustness
- **Confidence** - Plausible. Confirm with a Playwright test: register `?v=1`, deploy `v=2`, call `registration.update()`, and observe whether a new worker installs and activates once no client remains.
- **Evidence** - The Worker serves the current script for any `sw.js?v=` (`src/cloudflare/worker/routes/public.ts:49`, `worker/pwa/service-worker.ts:13`), while the registration keeps `?v=<old>` (`src/pwa/service-worker-registration.ts:6-12`). The browser's periodic and post-push update checks therefore install the new bytes and precache in the background (`src/pwa/service-worker/runtime.ts:49-69`), and the worker activates when no window is open. The next launch runs new code without passing `hasUnsettledReminders()`/`hasUnsettledReading()` (`apply-update.ts:53-73`), contradicting the comment at `service-worker-registration.ts:7-8`.
- **Proposed fix** - At the start of the install handler, reject (throw) when the script URL's `v` differs from `config.version`. The app's own `preparePwaUpdate` registers `?v=<new>`, so it is unaffected.
- **Effort** - S
- **Test to add** - The browser test above, asserting the old worker stays active and the cache name is unchanged.

### Low

#### F22. Binary upload retention uses a pre-transaction snapshot and can orphan the replaced R2 object

- **Severity** - Low (rare race; leaks storage permanently)
- **Dimension** - Robustness
- **Confidence** - Confirmed mechanism; needs a delete and same-bytes recreate inside one upload window
- **Evidence** - Non-Markdown uploads commit from the transfer object using `previousFile` read before staging (`src/cloudflare/worker/sync/file-handlers.ts:82,93-97`, `sync/batch/upload.ts:54,130`). The UPDATE matches on `hash` only (`sync/mutations.ts:71-74`; uploads never send a revision), but retention inserts the snapshot's key (`mutations.ts:115-127`). If the row changed to `{H1, K2}` in between, the commit replaces K2 while retaining the stale K1, and K2 is in neither `file_versions` nor `object_cleanup_queue`. Cleanup never lists the bucket, so K2 stays forever. `sync/import/initial-import-upload.ts:76,96-105` has the same shape. Markdown commits are not affected because they re-read the row under the coordinator lock.
- **Proposed fix** - Mirror `commitFileDelete`: before the UPDATE, in the same batch, `INSERT OR IGNORE INTO file_versions SELECT storage_key, path, hash, size, 'replaced', ... FROM files WHERE <the UPDATE's predicate> AND storage_key != ?`. No schema or protocol change.
- **Effort** - M
- **Test to add** - Worker-runtime: stage an upload against `{H1, K1}`, delete and recreate the same bytes (K2), commit, and assert K2 is retained.

#### F23. Mutation receipts and download revisions are persisted without validation

- **Severity** - Low
- **Dimension** - Code quality
- **Confidence** - Confirmed
- **Evidence** - Upload and download responses are cast without checks (`src/sync/worker-api/sync.ts:243,349,360,405`), and `durable-uploads.ts:153` only checks that the revision is truthy before it reaches the manifest. On reload, `src/protocol/sync-validation.ts:30-31` requires `isSyncRevision`, so a malformed revision is accepted, persisted, and then stops sync after a restart rather than failing the request that produced it.
- **Proposed fix** - Check `isSyncRevision` in `DurableUploads.validate` and on the download apply path.
- **Effort** - S
- **Test to add** - An upload receipt with `revision: 5` fails the upload, not the next checkpoint load.

#### F24. `reminders-upcoming` ignores `show-completed: true`

- **Severity** - Low
- **Dimension** - Code quality
- **Confidence** - Confirmed
- **Evidence** - `docs/embedded-reminders.md:27-34` documents `show-completed` for all three block types. `src/reminders/ui/plugin/reminder-list/reminderListModel.ts:53-55` loads all reminders and then calls `getUpcomingReminders`, which always drops completed ones (`src/reminders/core/reminderSort.ts:82`), so the completed section of an upcoming block is always empty.
- **Proposed fix** - Add an `includeCompleted = false` parameter to `getUpcomingReminders` and pass `showCompleted` from `loadRemindersListData`, or correct the doc.
- **Effort** - S
- **Test to add** - `reminderListModel.test.ts`: upcoming with `showCompleted` includes a completed reminder due tomorrow.

#### F25. Reading capture errors are never pruned, and each Reading restart keeps the old library alive

- **Severity** - Low
- **Dimension** - Robustness
- **Confidence** - Confirmed
- **Evidence** - `src/reading/data/library.ts:82` copies every `captureErrors` entry into the scan's issues; entries are only cleared when the same path is retried (`:203`), never on delete or rename, so "notes need attention" keeps listing missing notes until reload. Separately, `src/reading/runtime.ts:129` registers every vault and workspace ref with `plugin.registerEvent` although `stop()` already `offref`s them (`:133-134`); the plugin keeps those callbacks, and the `ReadingLibrary` they capture, until unload, once per Reading restart.
- **Proposed fix** - In `scan()`, delete `captureErrors` keys not in the current `paths` set before building issues. Delete `runtime.ts:129`.
- **Effort** - S
- **Test to add** - `library.test.ts`: fail a capture, remove the file, refresh, expect no issue.

#### F26. Encrypted Reading bounds in code are 10x the documented limits

- **Severity** - Low
- **Dimension** - Scalability
- **Confidence** - Confirmed mismatch; phone memory impact Plausible
- **Evidence** - `src/pwa/reading/encrypted-api.ts:19-20` allows 100,000 files and 64 MiB of metadata; `docs/reading-e2ee-assessment.md:25` says 10,000 files and 12 MiB. Every non-304 refresh stringifies and seals the whole list and index (`src/pwa/reading/storage/cache.ts:40-41,92`), several copies of up to 64 MiB at peak.
- **Proposed fix** - Set the constants to the documented 10,000 / 12 MiB, or update the doc if 64 MiB has been tested on a phone.
- **Effort** - S
- **Test to add** - `inventory()` rejects 10,001 files.

## 4. Simplification candidates

| Path(s) | What to delete or merge | Est. lines removed | Why safe |
| --- | --- | --- | --- |
| `src/reminders/query/remindersBlockLivePreview.tsx` (+ test), `query/editorFile.ts`, `remindersBlockOptions.ts:20-53`, `register-integrations.ts:37-41` | Live Preview CodeMirror extension | ~400 | Cannot render; code-block processors already cover Live Preview (F17) |
| `src/ui/cloudflare/server-picker-modal.ts` (+ test, `_dialogs.scss:181-189`, dialog fixture scene) | Delete; make `selectDeployment` required | ~170 | Every production call passes `progress.selectVault` (`src/plugin/cloudflare-operations.ts:257-261`) |
| `src/ui/activity/activity-modal.ts:31-52`, `panels.ts:37-51` | Make `ActivityModalDeps` required (`Pick<SyncRuntime, ...>`); drop `!` fallbacks and the micro-card branch | ~45 | All four production callers pass `SyncRuntime` |
| `src/ui/settings/settings-tab-model.ts` (+ test) | Inline the flags | ~40 | Four of five flags are the same expression |
| `src/sync/transfer/process.ts:152-166`, `engine/file-operations.ts:30-33`, `worker-api/sync.ts:282-290`, `deleteFile` in transfer/planner types | Single-file remote delete path | ~35 | Full sync filters deletes out before `applyDiffs` (`standard-sync-workflow.ts:199-202`); confirm the incremental conflict path never carries a `delete` diff before removing |
| `src/reminders/data/reminder-repository.ts:76-96,124-132` | `buildCreatedReminderFallback`; throw instead | ~30 | Reached only when a successful write does not read back; the Worker throws in the same case (`reminderFileCommand.ts:127`) |
| `scripts/pwa-startup-assets.mjs:13-25`, `scripts/build-worker.mjs:59`, `worker/pwa/client-bundle.ts:9-10`, `worker/pwa/service-worker.ts:10` | On-demand PWA asset machinery | ~25 | The build emits `onDemandAssets: []`; kept deliberately for a possible revert (7a6b817a), so confirm first |
| `src/sync/engine/force-sync-workflow.ts:60-68,86-87,142-151`, `contexts.ts:152-154` | Manifest snapshot, clear and restore | ~20 | Replaced by the F1 fix |
| `src/reminders/core/reminderProjectPath.ts:5`, `src/reminders/settings.ts:61,73`, `src/cloudflare/worker/request-validation.ts:6`, `src/pwa/config.ts:18` | Three copies of `containsControlCharacters` and two of `normalizeTimeString` into `src/platform/validation.ts` | ~20 | Byte-identical bodies |
| `.github/workflows/security.yml` | Delete; split the verify security step | ~18 | Same scan on the same events (F19) |
| `CRATE_PWA_PREBUILT` (3 checks, 2 setters, docs) | Replace with `CRATE_WORKER_PREBUILT` | ~15 | The worker flag is a verified no-op instead of a blind skip |
| `src/reminders/core/reminderMutationPlan.ts:46-95` | Return only `updates` | ~15 | Both callers read only `.updates` |
| `src/cloudflare/worker/auth/web-enrollment.ts:6-14,20` | `purgeExpiredWebEnrollmentTokens` | ~10 | Maintenance already deletes expired grants and every read checks `expires_at`; saves 2 D1 writes per link |
| `src/sync/worker-api/sync.ts:216-225` (+ 2 tests) | 404 fallback to the full manifest in `getFileMetadata` | ~10 | `/sync/metadata` predates the first release; today any 404 silently triggers a full manifest fetch |
| `src/pwa/reading/useReadingSync.ts:26-30,86`, `useReadingMutations.ts:26-30,40,92` | `mounted` refs guarding `setState` | ~10 | React ignores updates after unmount |
| `tests/visual/tsconfig.json`, `tests/editor-contract/tsconfig.json`, `typecheck:editor-contract` | One `tests/tsconfig.json` | ~10 | Identical compiler options |
| `src/sync/queue/controller.ts:188-194`, `flush.ts:184,214`, `flush-types.ts:30` | Merge `settle` into `release` | ~8 | Also fixes revision entries leaking for no-op keys |
| `upload.ts:151,154`, `upload-pipeline.ts:9,35`, `incremental.ts:23,140` | Test-only concurrency options | ~8 | No production caller passes them |
| `src/cloudflare/worker/sync/staging/bulk-new-file-commit.ts:12,31-33` | Dead `DELETE FROM staged_uploads` and optional `stagingBatchId` | ~4 | Callers always stage through `staged_upload_batches` |
| `src/pwa/service-worker/runtime.ts:180-182` | Empty `pushsubscriptionchange` listener | 3 | It does nothing |
| `src/reminders/runtime.ts:88`, `src/reading/runtime.ts:129` | Redundant `index.load()` and `registerEvent` loop | 2 | F11, F25 |
| `scripts/dev.mjs:33-34` | `usePolling` and `interval: 300` | 2 | Polls about 1,900 files every 300 ms with no stated reason |

Protocol candidates that need a compatibility check first (`docs/compatibility.md`): the Worker `POST /sync/delete` route has no production client (`engine.integration.ts:161` asserts the plugin never calls it), and `asset-upload-batches-v1` / `BATCH_ASSET_UPLOAD_CAPABILITY` is advertised but never checked by any client.

## 5. Things that are good

Keep these; they are load-bearing and easy to "simplify" by mistake.

- **Durable upload journal with server receipts.** Stable operation IDs, receipts written in the same D1 transaction as the CAS (including rejections), and replay after lost responses (`sync/durability/`, `worker/sync/upload-operations.ts`, `worker/sync/mutations.ts`).
- **Guarded deletion.** Every remote delete needs the acknowledged hash and revision plus a fresh local-absence check; local application of remote deletes goes through trash only.
- **One shared reminder core.** Parsing, recurrence, submission, list building and Today/Upcoming membership come from `src/reminders/core/` on all three hosts; the Worker's scan is a thin wrapper, and parity tests (`plaintext-parity.integration.ts`, `list-parity.integration.ts`) hold it together.
- **Atomic Markdown edits.** Reminder rewrites go through `processVaultMarkdown` inside `Vault.process` with an expected-content check, never a lossy read-modify-write.
- **Checkpoint generations with an append log** whose header names its base generation; a torn last line is tolerated and discovery fails closed instead of returning a partial inventory.
- **R2 lifecycle.** A lease is recorded before every put, cleanup claims before checking, deletion is reference-aware, restore copies to a fresh key, and nothing scans the bucket.
- **D1 query shapes.** Bound lists go through `json_each` and folder queries use primary-key ranges (`FILE_FOLDER_MATCH`), avoiding the 100-parameter limit and full scans.
- **PWA outbox discipline.** Exact request bytes and operation IDs persisted before dispatch, Web Locks around dispatch, and session fencing keyed by token hash.
- **Encryption formats.** JWE headers bind vault, scope, object, purpose and key ID, encodings are bounded and canonical before decryption, and pairing commits before revealing with the transcript as associated data.
- **Build hygiene.** Deterministic 2 s Worker build, metafile-driven `server-inputs.json`, no shipped sourcemaps, lazily decoded embedded Worker, a single budget source, and the ESLint-enforced Worker import allowlist.

## 6. Not checked

- **Suites not run:** `test:worker-runtime`, browser, visual and editor-contract suites. D1 row counts in F6 and F7 are estimates from query shapes, not metered `rows_read`.
- **Needs a real Obsidian or device:** popout windows (F20), Live Preview matching (F17), service worker update timing (F21), browser history persistence of fragments (F5), mobile timing of encrypted cold start (F9).
- **Plausible issues left out of the findings until measured:**
  - Startup runs about three full folder walks with automatic sync on (conflict recovery, startup sync and the post-sync probe in `sync/runtime/startup-sync.ts:31`); count `adapter.list` calls on a large vault.
  - The Activity pending list renders and diffs every pending file and rebuilds on each change (`ui/activity/pending-browser.ts:25-63,137-192`); test with about 5,000 pending keys.
  - Encryption-reset completion deletes every vault table in one D1 batch (`worker/encryption/reset.ts:101-112`); meter it against the Free-plan write limit.
  - Sync HTTP responses eagerly expose `response.text` for binary downloads (`sync/worker-api/http.ts:53`).
  - Unmemoized connection context values re-render both PWA runtimes (`pwa/connection/AppConnection.tsx:29-82`).
  - Native PWA macOS shards are unbalanced by about 200-300 s; `scripts/browser-durations.json` is a month old.
- **Areas only skimmed:** merge algorithms (`sync/merge/`), history restore apply, encryption reset and address workflows, plugin-side deployment/OAuth/server-reset state machines, `packages/server` backups and migrations, the Lexical reminder editor, highlight mapping, and PWA navigation and sheet hooks.
- **Leads not pursued:** whether Obsidian `secretStorage` is per vault (the unscoped `crate-device-id` would be shared across vaults if not); a race where the Reading settings flow hard-codes `enabled: true` (`reading/ui/plugin/settings-section.ts:33`); host-locale `localeCompare` in a stored receipt hash (`encryption/reminder-receipt.ts:6`); and doc drift in `docs/protocol.md:45` (outbox batch of 5 vs 10 in code), `docs/worker-api.md:572` (100 vs 1,000) and the Secret Storage table in `docs/architecture.md`.
