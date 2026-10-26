# Engineering audit, third pass - 2026-10-26

Scope: the repository at `9508a3fd` on `feat/engineering-audit-38a854`, after the D1 refactor (`659409ff`, `acd1a1b2`) and the 46 fixes from the [second pass](2026-10-25-engineering-audit-2.md) (its section 7 maps each finding to a commit). Seven area audits ran in parallel (D1 refactor; Worker fixes and `packages/server`; sync; reminders and Reading; PWA; UI, plugin and deployment; build and CI). Each reviewed the commits in its area first, then areas earlier passes only skimmed. The lead re-read the cited code for every Critical and High finding before including it. Findings rated Medium or above are fixed on this branch, one commit each; section 7 records the results.

Checks at `9508a3fd` (from the second-pass results): lint, `typecheck`, `typecheck:worker`, `typecheck:service-worker`, `deadcode`, `build`, `size-check`, `security:audit`, `check:server-revision`, 5,436 of 5,436 unit tests and 859 of 859 Worker-runtime tests pass. `typecheck:visual` fails (H3). Browser and visual suites were not run locally; CI results are summarized in H4.

## 1. Summary

- The 51 commits since the first pass are mostly correct. Two introduced or exposed new bugs: the second pass's import fix (C1 follow-up and M4) and the persisted shared-settings base (M9).
- Two Critical issues remain, both confirmed with Worker-runtime reproductions. Ordinary uploads from a second device during an unfinished first upload are pruned and then trashed on that device (C1). A refused **Turn on encryption** leaves the new keys saved, so the next start uploads encrypted files with random names to an unencrypted server and reports success (C2).
- The PWA can show healthy encrypted pending changes as "damaged" while Reminders is locked and lets the user remove them (H1).
- The D1 refactor holds up: every `files` writer updates the Reading index in the same batch, rebuilds are idempotent, and authentication under the coordinator lock covers scope, revocation and expiry. Its costs left over are the Reading read wake (M1) and a full library reload after every Reading save (M2).
- The reminder round-trip check from the second pass is correct but too strict for date-only reminders with number ranges (M7), and the underlying grammar problem also rewrites note text (M8).
- CI on master has no green run since 2026-10-24. This branch fixes the advisory failure; the secret scan (H2), `typecheck:visual` (H3) and a set of stale browser and visual tests (H4) still fail. The browser runner and two test configurations turn load into failures or 15-minute hangs (M10, M11, M12).

## 2. Top 10

| Rank | Finding | Severity | Effort |
| --- | --- | --- | --- |
| 1 | C2 - A refused encryption setup leaves keys saved; the next start uploads encrypted files to an unencrypted server | Critical | S |
| 2 | C1 - Ordinary uploads during another device's unfinished first upload are pruned and then trashed | Critical | S |
| 3 | H1 - Locked encrypted pending reminder changes show as damaged and can be removed | High | S |
| 4 | H2 - The secret scan fails on synthetic test keys | High | S |
| 5 | H3 - `typecheck:visual` fails and the gallery silently drops project pills | High | S |
| 6 | M1 - Reading list and item reads still wake notification processing and reset its backoff | Medium | S |
| 7 | M9 - A device with its own config folder never adopts other devices' exclusion changes | Medium | S |
| 8 | M5 - A failed shared checkpoint save is retried after every sync | Medium | S |
| 9 | M7 - Date-only reminders with a number range are refused although the ISO form reads back | Medium | S |
| 10 | M10 - A hanging browser test script uses up the whole CI job | Medium | S |

## 3. Findings by severity

### Critical

#### C1. Ordinary uploads during another device's unfinished first upload are pruned, then trashed on the uploading device

- **Severity** - Critical (data loss)
- **Dimension** - Robustness
- **Confidence** - Confirmed (two-device Worker-runtime reproduction: B flushed `b.md` during A's open import; A's next sync left only `a.md` on the server; B's next sync reported success with `deletedPaths: ['b.md']`)
- **Evidence** - The Worker accepts ordinary uploads while the import is open (`src/cloudflare/worker/sync/mutations.ts:41-61`). Device B's `sync()` stops with `ANOTHER_DEVICE_IMPORTING` (`src/sync/engine/initial-import.ts:47-49`), but the queue flush (`src/sync/queue/flush.ts`) and **Sync selected** (`src/sync/engine/engine.ts`, `reconcileFromQueue`) still upload. A's next import run prunes every server path missing locally with no retained version (`initial-import.ts:53-56`, `src/cloudflare/worker/sync/import/initial-import-prune.ts:27-32`); B then sees local equal to base with the remote gone and trashes the file (`src/sync/planner/reconciliation.ts:63`). **Turn off encryption** creates exactly this situation, since the wiped server is never-populated while other devices reconnect.
- **Proposed fix** - Before uploading in the flush and in **Sync selected**, check `(await api.initialImport?.begin())?.state === 'importing'`; if open, requeue and stop with "The first upload of this vault is unfinished. Select **Sync now** on the device that started it." `begin()` caches an established server, so established vaults pay one request per session. Leave force full sync unguarded (it is the escape in M4).
- **Effort** - S
- **Test to add** - The reproduction in `initial-import-devices.integration.ts`: B's flush uploads nothing while the import is open; after A finishes, `b.md` is still on B and syncs.

#### C2. A refused encryption setup leaves the new keys saved; the next start uploads encrypted files to an unencrypted server

- **Severity** - Critical (corruption and divergence on every device while sync reports success)
- **Dimension** - Robustness
- **Confidence** - Confirmed (Worker-runtime reproduction: refuse setup with a pending saved link, `initialize()`, edit two notes, sync; the server stored two files with 26-character random names and encrypted bytes, and a plain second device downloaded them)
- **Evidence** - `src/sync/runtime/encryption-reset-workflow.ts:54` saves the keys before the server accepts the setup. The rejection branch (`:127-136`) deletes only the reset checkpoint. The server refuses setup with 409 while a saved link is downloading or a first upload is running. On the next start `runtime.initialize` loads the keys and configures encryption without checking the server (`src/sync/runtime/runtime.ts:302-303`), and `validateUploadEncryption` accepts any upload when the vault has no encryption state (`src/cloudflare/worker/encryption/state.ts:58`).
- **Proposed fix** - In the rejection branch, when the target is `encrypted`, delete `ENCRYPTION_KEYS` and `ENCRYPTION_RECOVERY` and verify they are gone. The in-memory prepared keys (2293bd5d) keep the recovery key the user already copied.
- **Effort** - S
- **Test to add** - Extend "releases a setup the server refuses to start" in `reset-runtime.integration.ts`: keys are gone after the refusal, and a following `initialize()` and sync store only plain rows.

### High

#### H1. Locked encrypted pending reminder changes show as damaged and can be removed

- **Severity** - High (unsent edits can be lost through a misleading recovery prompt)
- **Dimension** - Robustness
- **Confidence** - Confirmed at the storage level (sealed change, `requirePrivateStorageUnlock()`, then `load()` returns nothing and `quarantined()` returns the ciphertext); UI path by code reading
- **Evidence** - The outbox is created even when the encryption check fails: `useReminderSync.ts:285` sets `hydrated` in `finally` and `RemindersRuntime.tsx:47` turns that into `bootstrapped`. While locked, private storage returns raw ciphertext (`src/pwa/reminders/private-storage.ts`), `readStored` fails to parse it, and every sealed change moves to `quarantined()`. `SettingsSheet.tsx` shows "N saved changes need recovery" with **Remove exported copies from device**, reachable through Reading while Reminders is locked.
- **Proposed fix** - Pass `bootstrapped && connection.encryption.status !== 'locked'` to the mutations hook in `RemindersRuntime.tsx`, so the outbox opens only once the check succeeds. `hasUnsettledReminders()` still blocks updates.
- **Effort** - S
- **Test to add** - Store a sealed change, lock private storage, mount the outbox: no quarantine entries; after unlocking, `load()` returns the change.

#### H2. The secret scan fails on synthetic test keys

- **Severity** - High (fails the checks job and `release:check` on master and this branch)
- **Dimension** - Robustness
- **Confidence** - Confirmed (CI run 40224596500)
- **Evidence** - Gitleaks reports `generic-api-key` at `src/encryption/path-tags.test.ts:9` and `:37`; the values are the bytes 0-31 base64url-encoded. A `.gitleaksignore` fingerprint covers only the history scan, because the source scan copies files to a temporary directory (`scripts/check-secrets.mjs`).
- **Proposed fix** - A second `[[allowlists]]` block in `.gitleaks.toml` scoped to that test file and those exact values.
- **Effort** - S
- **Test to add** - `npm run security:secrets` passes.

#### H3. `typecheck:visual` fails and the visual gallery silently drops project pills

- **Severity** - High (fails the checks job once H2 is fixed and skips the release artifact steps after it)
- **Dimension** - Robustness
- **Confidence** - Confirmed
- **Evidence** - `MotionFixture.tsx`, `NavigationFixture.tsx` and `ReminderListStyleFixture.tsx` in `tests/visual/gallery/` omit the `colorScheme` prop made required in 4d3d0d82. At runtime `ReminderCard` then skips the project pill, so the pill assertions in `reminder-list-style-cases.ts` no longer cover it. The CI step (`verify.yml`) has no `!cancelled()`, so it has been skipped behind earlier failures.
- **Proposed fix** - Pass the gallery's existing `theme` through to these fixtures and their views (`main.tsx` already reads `?theme=`).
- **Effort** - S
- **Test to add** - `npm run typecheck:visual` passes; the list-style case sees `.premium-pill-project`.

#### H4. Master's browser and visual jobs fail on tests left stale by UI commits

- **Severity** - High (no green master build since 2026-10-24)
- **Dimension** - Robustness
- **Confidence** - Confirmed that failures are deterministic (each also failed its CI retry); root cause confirmed for two: 664edde7 removed the back-button gradient that `pwa-project-transition-test.mjs` still expects, and 33b342e6 hides Share without native sharing while `reading-highlight-cases.ts` still expects it. The rest are Plausible (icon and dock changes on 2026-10-24 and 25).
- **Evidence** - Failing: Visual 1/2 and 2/2, PWA 3/4 and 4/4, Native PWA 2/2, Editor 2/4, Reading library and annotations (CI run 40224596500).
- **Proposed fix** - Update assertions for intended UI changes; regenerate screenshot baselines only through the reviewed `update_baselines` flow.
- **Effort** - M
- **Test to add** - The existing suites.

### Medium

#### M1. Reading list and item reads still wake notification processing and reset its backoff

- **Severity** - Medium
- **Dimension** - Performance and speed
- **Confidence** - Confirmed (Worker-runtime: a 304 `GET /reading/list` reset `notificationRun` from `{passes: 50, failures: 5}` to zeros)
- **Evidence** - `src/cloudflare/worker/routes/policy.ts` gives both routes `COORDINATOR` (`wake: true`), so `request-handler.ts` arms a full notification pass (28 rows) per request and resets the 8-failure backoff. The projection these routes used to run is gone; only an incomplete index rebuild needs a pass.
- **Proposed fix** - Use `COORDINATOR_READ`, pass the coordinator state to `handleReadingRoute`, and arm only when the index is incomplete.
- **Effort** - S
- **Test to add** - A 304 list leaves the run state unchanged; a list against an emptied index arms the coordinator.

#### M2. Every Reading save reloads the whole library

- **Severity** - Medium
- **Dimension** - Scalability
- **Confidence** - Confirmed (10,000 notes: update 55 rows, the following reload 10,046 rows over 11 pages)
- **Evidence** - After a confirmed drain, `src/pwa/reading/outbox.ts` calls `loadReading(session)` without the cache, and every write bumps the library revision, so even a conditional reload is a 200. About 480 saves a day per device exhaust the Free-plan read allowance.
- **Proposed fix** - Return the library revision before and after each Reading write; when the client's cached revision chains through its writes, patch the cached items instead of reloading. Additive response fields; old clients keep reloading.
- **Effort** - M
- **Test to add** - Extend `reading/d1-usage.integration.ts` to replay a drain (update, then reload) under about 200 rows.

#### M3. A PWA encryption browser test crashes and two state checks test nothing

- **Severity** - Medium
- **Dimension** - Code quality
- **Confidence** - Confirmed by code reading
- **Evidence** - `tests/browser/pwa/pwa-encryption-test.mjs` reads `maintenance_state` key `e2ee:state`, which moved to `server_state.encryption` in 659409ff, so `.first().value` throws. `pwa-encryption-reset-checks.mjs` asserts the same dead row is null. `tests/fixtures/recovery/restore-policy.{json,sql}` keep the feature policy under the dead `crate_feature_policy` key, so `server-restore.test.ts` no longer covers it.
- **Proposed fix** - Read and update `server_state` in the tests and move the fixture's policy to a `server_state` row.
- **Effort** - S
- **Test to add** - The updated fixture assertion.

#### M4. The device that started an initial import is locked out of it after its checkpoint is cleared

- **Severity** - Medium (regression from the second pass's C1 fix)
- **Dimension** - Robustness
- **Confidence** - Confirmed (reproduced)
- **Evidence** - Disconnecting or reinstalling clears the checkpoint and its import token; `initial-import.ts:47-49` then refuses the only device with a message naming "another device". **Replace server files** recovers it.
- **Proposed fix** - Name the escape in `ANOTHER_DEVICE_IMPORTING` and in `docs/upload-recovery.md`.
- **Effort** - S
- **Test to add** - The reproduced scenario: the message names **Replace server files**, and force sync then sync completes the import.

#### M5. A failed shared checkpoint save is retried after every sync

- **Severity** - Medium
- **Dimension** - Scalability
- **Confidence** - Confirmed by code reading
- **Evidence** - `lastCheckpointAt` advances only on success (`src/sync/runtime/runtime.ts`, `recordSyncResult`), and `checkpointDue` returns true while nothing ever succeeded (`sync-activity.ts`). Above 100,000 files the Worker reads 100k rows before refusing, so every queue flush that did work costs about 100k D1 rows.
- **Proposed fix** - Record the attempt time before the `try`, so failures are spaced like successes.
- **Effort** - S
- **Test to add** - A rejecting save with 100,001 tracked files is attempted once across two automatic results.

#### M6. Earlier sign-ins' plaintext Reading copies are kept once the session is encrypted

- **Severity** - Medium (plaintext articles stay on the device after the vault switched to end-to-end encryption)
- **Dimension** - Robustness
- **Confidence** - Confirmed (temporary test)
- **Evidence** - `isReadableCopy` (`src/pwa/reading/storage/cache.ts`) decodes through `decodeReadingValue`, which throws for plaintext records once a cipher is required, so 95481599 treats them as unreadable and keeps them.
- **Proposed fix** - Decode only records that carry `encryptedReading`; accept plaintext records by shape.
- **Effort** - S
- **Test to add** - Under an unlocked cipher, an earlier session's plaintext list and article are removed and another vault's ciphertext is kept.

#### M7. Date-only reminders with a number range are refused although the ISO form reads back

- **Severity** - Medium
- **Dimension** - Robustness
- **Confidence** - Confirmed
- **Evidence** - The read-back check (`src/reminders/core/markdownReminderMutation.ts`) tests only the `Oct 30, 2026` form that the line builder writes for date-only dues, while the plugin's normalizer writes `2026-10-27`. A note line `- [ ] Pages 20-30 2026-10-27` reads fine, but every later edit of it, on any host, is refused.
- **Proposed fix** - When a date-only line fails the check, rebuild it once with the ISO date (already readable by every host) and refuse only if that also fails.
- **Effort** - S
- **Test to add** - "Pages 20-30" date-only saves on the plugin and the Worker; a description-only edit of the ISO line succeeds; "Read pages 13-19" is still refused.

#### M8. The end of a typed number range is read as an hour, and the plugin rewrites the note line

- **Severity** - Medium
- **Dimension** - Robustness
- **Confidence** - Confirmed
- **Evidence** - Chrono reads "10 tomorrow" as 10:00 tomorrow (`reminderSchedule.ts`), and `normalizeReminderSchedule.ts` replaces that text in place: `- [ ] Exercises 5-10 tomorrow` becomes `- [ ] Exercises 5-2026-10-27T09:00:00.000Z`.
- **Proposed fix** - In `findReminderScheduleMatches`, when a chrono result begins with the digits right after a range dash, re-parse from after the number. This makes currently refused lines readable, so `docs/compatibility.md` requires a parser cache version bump.
- **Effort** - M
- **Test to add** - The three titles keep the full range in the title and use only the day as the schedule, in both the editor parse and the normalizer.

#### M9. A device with its own config folder never adopts other devices' exclusion changes

- **Severity** - Medium (newly excluded folders keep uploading from that device)
- **Dimension** - Robustness
- **Confidence** - Confirmed (temporary test)
- **Evidence** - Saving settings appends this device's `<configDir>/workspace*` pattern (`src/plugin/settings.ts`), so its local list always differs from the saved base, and `rebaseSharedSettings` treats every remote change as a conflict and keeps local. Since 3588b822 persisted the base, this survives restarts.
- **Proposed fix** - Leave this device's own `<configDir>/workspace*` pattern out of the shared view for local, base and remote values in `shared-settings-sync.ts`.
- **Effort** - S
- **Test to add** - With `writeSettings` appending `.m/workspace*`, a remote pattern change is adopted on the next pull and closing settings shows no conflict notice.

#### M10. A hanging browser test script uses up the whole CI job

- **Severity** - Medium
- **Dimension** - Performance and speed
- **Confidence** - Confirmed (PWA shard 1 hung in `pwa-encryption-storage-test.mjs` until the 15-minute job timeout; diagnostics were skipped)
- **Evidence** - `scripts/browser-tests.mjs` runs each script with `spawnSync` and no timeout; the longest script in any CI run takes 180 s.
- **Proposed fix** - Pass a 6-minute `timeout`; the existing signal branch then fails the step and uploads diagnostics.
- **Effort** - S
- **Test to add** - `browser-tests.test.mjs` asserts the option.

#### M11. Wall-clock limits of 300 ms make unit tests fail under load

- **Severity** - Medium
- **Dimension** - Robustness
- **Confidence** - Confirmed
- **Evidence** - `conflict-diff.test.ts`, `lookup-store.test.ts` and `reminder-clock.test.ts` assert `performance.now() - started < 300`; CI already takes 109-231 ms. The regressions they guard took 1.9-3 s.
- **Proposed fix** - Raise the three limits to 1,000 ms, matching `manifest-renames.test.ts`.
- **Effort** - S
- **Test to add** - None.

#### M12. Cold first Worker-runtime tests sit close to the 5 s default timeout

- **Severity** - Medium
- **Dimension** - Robustness
- **Confidence** - Confirmed for timings (2.3 s on CI for the first Defuddle extraction); the token UNIQUE cascade after a timeout is Plausible
- **Evidence** - `vitest.cloudflare.config.ts` sets no `testTimeout`. A timed-out body keeps writing while the next test inserts the same fixed token.
- **Proposed fix** - `testTimeout: 20_000`.
- **Effort** - S
- **Test to add** - None.

### Low (not fixed in this round)

| Finding | Evidence | Proposed fix |
| --- | --- | --- |
| A refused saved login leaves `helperUploadPending` set and blocks server deletion | `src/cloudflare/server-reset/delete.ts:75-81` checks only `CloudflareApiError` | Treat `CloudflareReauthorizationRequired` as a refusal, as 60f42969 did in `fence.ts` |
| 21388a49 breaks remote deletes for the 0.7.0 beta | 0.7.0 calls `POST /sync/delete` | One line in `docs/compatibility.md` |
| Unauthenticated coordinator requests queue on the write lock | `request-handler.ts` forwards before authenticating | Forward only when an admission key exists |
| Startup replay re-reads every file the startup sync downloaded | `runtime.ts` records download events as uploads | Settle replayed keys whose stat matches the manifest |
| A stale restore preview leaves its staging folder | `src/sync/history/restore.ts` | Remove the folder when the second verify throws |
| `docs/protocol.md` calls skipped oversized files errors | `docs/protocol.md:19` | Say issues |
| Encryption check refusals (423, 403, 429) read as connection errors | `src/pwa/connection/encryption.ts:42` | Use the server's `error` text |
| A background-prepared service worker can activate on a cold launch | `usePwaUpdate.ts` | Document it |
| `decodeHtml` lets a header charset override a byte order mark | `src/reading/extraction/charset.ts` | Check BOMs first |
| IME composition can be overwritten in the mobile reminder modal | `RichTextInput.tsx:119-143` | Skip the sync while composing |
| The PWA's predicted reminder differs from what the server saves | `reminder-optimistic-state.ts:15-20` | Use the built dates and rule |
| The usage error names a removed reconnect flow | `src/cloudflare/usage/service.ts:48` | Point to **Reconnect** under **Account and devices** |
| Deleting one server may sign out other vaults on the same account (Plausible) | `crate-usage-oauth-<account>` | Document it |
| The cold-start settings pull races the startup sync | `src/plugin/lifecycle.ts` | Accept |
| A limiter test depends on the minute boundary | `security-boundaries.integration.ts` | Use a counting stub |
| The docs site's dependencies are never audited or updated | `dependabot.yml` | Add a grouped `/docs-site` entry |

Plausible, outside any area: **Update server address** on an encrypted vault pointed at a restored server can keep a `lastSeq` ahead of the restored changelog, and `cursorExpired` does not catch `since > lastSeq` when `minSeq <= since + 1`.

## 4. Simplification candidates

| Path(s) | What to delete or merge | Est. lines | Why safe |
| --- | --- | --- | --- |
| `notifications/outbox.ts`, `coordinator/coordinator.ts`, `coordinator-requests.ts` | `remindersEnabled` parameter and `REMINDERS_ENABLED_HEADER` | ~10 | Both production callers pass `true` since 170bec22 |
| `deployment/fence.ts`, `server-reset/delete.ts`, `deployment/provisioner.ts` | One `isDefiniteProviderRefusal(error)` helper for four copies of the same condition | ~3 net | Also fixes the `helperUploadPending` Low |
| `reading/captures.ts:53`, `reading/queries.ts:35` | Revision bump on the capture lease | ~2 | The PWA sorts captures by `saved_at` |
| `src/sync/issues.ts:61-64` | `SkippedFileError` branch in `recordSyncError` | ~4 | Handled before it is reached since 7359e8e6 |
| `src/sync/engine/initial-import.ts:42-52` | Move the ownership check before the vault walk | 0 | Saves a full walk on every blocked attempt |
| `src/ui/activity/activity-status.ts`, `activity-modal.ts` | `canStopSync` parameter | ~3 | Always `true` since d2031110 |
| `src/pwa/reminders/useReminderMutations.ts:130-132` | Synchronous error path around `discard` | ~2 | `discard` always returns a promise since fead84f1 |
| `scripts/bundle-budgets.mjs:62-69` | PWA `app.js` budget row | ~7 | Every asset loads at startup; all-assets bounds them |

## 5. Things that are good

- **Reading index in the commit batch.** Every index row is conditional on the exact file revision and folder written in the same D1 batch, so rejected, raced and concurrent rebuild writes cannot leave stale rows.
- **Authentication under the coordinator lock.** Scope, revocation and expiry are checked under the same lock every revocation takes; the edge's credential memory affects admission only.
- **Same-batch retention.** Replaced-object retention reads the live row inside the write batch, which made dropping the pre-read in 410f37b4 safe.
- **Round-trip check in shared builders.** Plugin, Worker, encrypted PWA path and PWA prediction all refuse an unreadable line before writing.
- **Encrypted reminder index binding.** Bound to build, vault, key generation and folder forms, so skipping unchanged reseals cannot carry a stale index across a key change.
- **Pairing.** Commit-before-reveal, pinned keys and a verification code bound to vault, origin and generation.
- **Local server data safety.** A file lock plus Docker leases, hash-verified backups published by rename, and restore validated in staging before its marker is written.

## 6. Not checked

- Browser, visual and device suites (not run locally); the root cause of the `pwa-encryption-storage` CI hang.
- Real Cloudflare CPU use of a Reading index rebuild page; restores of backups taken before the D1 refactor (pre-launch schema policy).
- Native IME, dictation and keyboard behavior; service-worker activation timing on iOS.
- Whether Obsidian secret storage is shared across vaults on each platform.

## 7. Results

Fixed on `feat/engineering-audit-38a854` in this worktree, one commit per change, after this report (`c0e6ff71`). Every Critical, High and Medium finding is addressed; Low findings are left as listed.

| Finding | Commit | Notes |
| --- | --- | --- |
| C1 | `1b9c68db` | Queue flushes, queued reconciliation and **Sync selected** check for an open first upload and wait; force full sync stays the escape. Reproduced with a two-device Worker-runtime test first. |
| C2 | `2398f03a` | Fails without the fix in `reset-runtime.integration.ts`. |
| H1 | `c99654e3` | The outbox hook itself waits for Reminders to unlock, so every caller gets the gate. |
| H2 | `e265e457` | `security:secrets` passes; it reports both leaks without the allowlist. |
| H3 | `9ad2e942` | Also lets the CI step report independently (`!cancelled()`). |
| H4 | `4344c8db`, `6166a423`, `5b8a26fb`, `f855bfa5`, `03585ce5`, `426801b8` | Root causes: the PWA cache test expected the pre-H2 deletion on lock; the plugin's delete confirmation never passed its `alertdialog` role (a product fix); four assertions predated the flat chrome (664edde7), native-only Share (33b342e6), arrow submit (2de280d2) and 6px buttons (7131b27c); the encrypted push test registered its worker without the version f514893f requires, which crashed and then hung CI's PWA shard 1; background prefetch (cd755eb3) cached the touch test's articles; WebKit samples the update handoff bars 1-2px apart, so the bound is now 3px (a rewind differs by tens). Eight screenshots still differ (see below). |
| M1 | `ab725071`, `f79e19a7` | Reads arm the coordinator only when they ran an index rebuild step; the second commit makes its runtime test deterministic. |
| M2 | `29b3c99e` | Updates and retries return `library: { before, after }` (additive). A client whose cache chains re-reads only the edited items. |
| M3 | `7b8187ab` | The encryption browser test passes in Chromium and WebKit. |
| M4 | `dc74fc2f` | The message names **Replace server files**. |
| M5 | `67708aee` | |
| M6 | `881fdb45` | |
| M7 | `ef66fdd7` | Date-only dues fall back to `2026-10-30` when only that form reads back. |
| M8 | `82926331` | Reminder parser version 2; a number right after a range dash stays in the title. Together with M7, "Read pages 13-19" now saves; titles ending in a time ("Lunch at 1pm") are still refused. |
| M9 | `d81fe5fa` | Local, base and server settings are compared with this device's own workspace pattern applied. |
| M10 | `ca853677` | Confirmed in the local run: the hanging script failed after six minutes and the runner continued. |
| M11 | `12ee972c` | |
| M12 | `1de6d0a4` | |

Checks on the final branch: `lint` (0 errors), `typecheck`, `typecheck:worker`, `typecheck:service-worker`, `typecheck:visual`, `deadcode`, `build`, `size-check`, `security:audit` (0 vulnerabilities) and `check:server-revision` (revision 1, pre-launch baseline) pass. `npm test` passes 5,446 of 5,446, `npm run test:worker-runtime` 863 of 863, `npm run test:pwa-browser` 58 of 58 scripts, the editor contract suite 536 of 536, `test:reading-server` 24 of 24 and both Reading browser groups (28 and 5). `test:visual` passes 559 of 567.

Not done:

- The eight failing visual cases are screenshot comparisons only: `shared-ui` PWA editor, cards and flat scenes (7) and `reading-appearance-pwa` (1). Their diffs are the completed-reminder and project chip icons (79b4f481, a1ad95f4) and the compact sheet header (2de280d2). Baselines were not replaced; regenerate them through the reviewed `update_baselines` workflow.
- macOS-native PWA shards and CI runners were not run; device behavior (Save-Data prefetch, service worker activation, IME) is unverified.
- The plugin now ships reminder parser version 2, which revalidates every reminder source once after the Worker update (`docs/deployment.md`).
