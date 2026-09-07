# Crate pre-release engineering audit

> Historical baseline findings. The subsequent fixes and current verification results are recorded in [Audit remediation](audit-remediation.md).

Audited 6 September 2026. Candidate: `12f01b7` (`feat: add pwa pull-to-refresh and cloudflare sync recovery`), manifest/package version `0.1.0`. Scope: Obsidian plugin, sync protocol, Worker/D1/R2, Durable Object notifications, reminders domain, PWA, deployment, CI and repository history. Production source was left unchanged.

## 1. Executive summary

**Recommendation: do not release this candidate for use with real vaults. Readiness: 57/100.**

The underlying design is promising: immutable remote objects, conditional metadata writes, a shared three-way reconciliation policy, deterministic Markdown merging, local conflict copies, recoverable checkpoints, and retained remote versions. There is substantial testing, including real local Cloudflare bindings. This is considerably more than a simple timestamp-based file copier.

However, the guarantees break at several distributed-system boundaries. An uncertain D1 commit causes upload handlers to delete the object the database has just committed. Retrying can report success while that object remains missing. Stale reminder editors overwrite newer fields despite file-level conditional writes. Non-Markdown local downloads have an unchecked interval between validation and replacement. These are the three release blockers.

Additional serious issues include timezone information disappearing during Markdown serialization, non-idempotent reminder creation and recurring completion, notification ordering races, unsafe Worker downgrades when joining an existing deployment, and failed PWA saves losing drafts. More stylistic cleanup would contribute much less than fixing these invariants.

### Evidence and limits

I traced implementations and call sites, reviewed existing tests, ran builds/checks, injected failures into real local D1/R2 handlers, simulated client interleavings, and exercised the PWA with Playwright. [Reproduction sources and logs][evidence] are preserved separately from the normal test suite. Their assertions demonstrate current defects; passing them means the defect reproduced.

| Check | Result |
|---|---|
| Production build, supported Node 24.19.0 | Passed |
| Lint, plugin/Worker type checks, dead-code analysis | Passed; repeated under supported Node after removing temporary source tests |
| Baseline unit suite, Node 24.19.0 | **978 passed, 3 failed; 171/173 files passed** |
| Existing real local Cloudflare runtime suite | **13/13 passed**, two files |
| Additional Worker failure/concurrency reproductions | **9/9 reproduced**, real local D1/R2; includes all four uncertain-commit paths |
| Additional local/domain/DO/PWA-hook reproductions | **5/5 reproduced** with controlled dependencies/interleavings |
| PWA preview smoke, CSS scoping, size budgets, release artifacts, third-party notices | Passed |
| Existing PWA browser command | Cache tests passed in Chromium/WebKit; focus test timed out before exercising its assertions |
| Focus test with explicit Inbox route | Passed Chromium and WebKit; baseline fixture assumed Inbox although startup selects Today |
| UI performance browser script, run separately | Failed at pull threshold; adjusting gesture exposed a further layout expectation mismatch |
| Additional browser defect test | Chromium reproduced draft loss and cross-tab logout residue; WebKit run timed out during failed-save rollback, so no equivalent WebKit conclusion |
| Dependency audit | 0 production advisories; 2 high and 1 moderate in transitive development packages |
| Local Git history pattern scan | 438 commits, 4,932 text blobs, about 43 MB; no matches for the credential/private-key patterns used |

An initial check used the shell's unsupported Node 23.4.0; the baseline unit failures were reproduced on supported Node 24.19.0. The full release gate is **not green**. I did not perform a clean `npm ci`, certify cross-Node byte reproducibility, execute the community-directory review scanner, run the full visual snapshot suite, deploy to a live Cloudflare account, or test real Obsidian/iOS/Android devices. Local workerd tests establish behavior with real bindings under injected faults, not the frequency of those faults in production. The custom history scan is not an exhaustive secret scanner and covers locally available refs, not inaccessible remote/deleted history.

## 2. Release blockers

### F01 — Uncertain metadata commits delete committed file content

**Severity:** BLOCKER. **Confidence:** Confirmed. **Category:** Confirmed bug. **Area:** Worker storage transaction lifecycle.

**Problem / why it matters:** Several mutation handlers treat an exception from a D1 batch as proof of rollback and delete their staged R2 objects. A transport failure after commit invalidates that assumption. The live file and changelog can point to bytes that cleanup has permanently removed from R2.

**Failure sequence:** (1) Upload stages a fresh immutable object. (2) D1 successfully commits the file row, change record and version retention. (3) The database response is lost and `batch()` throws to the handler. (4) Its catch block deletes the staged key. (5) Download returns 503 because the live object is absent. (6) Retrying the same upload returns 200 through same-hash idempotence, but still does not restore the missing key. A newly created PWA reminder may have no other durable copy; for updates, a retained older version does not preserve the lost latest edit.

**Files/symbols:** [handleUpload][upload], [handleBatchUpload][batch-upload], [writeCommittedMarkdownFile][markdown-write], [writeCommittedMarkdownFilePair][pair-write], [commitStagedFile][commit], [deleteBucketObjectsOrQueue][cleanup]. The four primary reproductions commit real local D1 transactions before throwing; both files in the pair-write case become unreadable.

**Root cause:** D1 and R2 do not share a transaction, and cleanup confuses “outcome unknown” with “definitely unreferenced.” Queue drainage also deletes without checking live/version references. D1 batches provide SQL transaction boundaries; this does not make external object deletion transactional. [Cloudflare D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/)

**Recommended change:** Reuse the safer lifecycle already implemented by [handleRestoreFileVersion][restore]: keep staged bytes when commit outcome is uncertain and let age-delayed, reference-aware orphan cleanup decide later. Centralize this policy across single, batch, reminder and pair writes. Never delete a key referenced by either `files` or `file_versions`; reconcile ambiguous commits using their operation/object identity.

**Proving tests:** For all four entry points, inject failure before execution, during a rolled-back transaction, and after a successful commit. After arbitrary retries and GC passes, every live/retained reference must resolve to correct bytes. Include a same-payload retry returning success and a restore racing cleanup. Existing restore lost-response coverage is the template, not evidence the other paths are safe.

### F02 — Stale reminder editors silently overwrite newer fields

**Severity:** BLOCKER. **Confidence:** Confirmed. **Category:** Confirmed bug. **Area:** PWA/Obsidian reminder mutation semantics.

**Problem / why it matters:** Reminder identity is stable, but displayed reminder state has no revision. Server-side file CAS protects only the interval after the handler reads the latest file. It does not protect the user's editing base. The plugin's own stable-ID fallback has the same stale-record problem.

**Failure sequence:** (1) PWA opens a reminder titled “old title.” (2) Obsidian changes it to “new title” and uploads successfully. (3) PWA changes only its description and saves the whole old form. (4) Worker reads the latest file, uses its current hash as the expected hash, and overwrites the title with “old title”; response is 200. Separately, a plugin editor/index record holding the old title can change priority after another vault write; the stable-ID match finds the changed block and replaces it using stale fields. Both behaviors reproduced.

**Files/symbols:** [useReminderMutations.saveReminder][pwa-mutations], [ReminderMutationBody][pwa-types], [handleUpdateReminder][reminder-update], [updateReminderInMarkdown][plugin-update], [buildUpdatedReminderBlock][block-update], [findReminderLineNumber][find-reminder].

**Root cause:** Stable IDs identify records but are used as if they also establish freshness. Whole-form updates include fields the user never intended to change.

**Recommended change:** Include a reminder/block revision or expected base and send field-level edits. Compare the submitted base with current state before committing; merge disjoint field changes or return a conflict preserving the draft. In Obsidian, parse and compare the current block inside `vault.process()` before constructing its replacement. File CAS must remain in addition to reminder revision checks.

**Proving tests:** Plugin/PWA and two-tab edits to different fields must preserve both edits; competing same-field edits must conflict visibly. Test title, description, project moves, due dates, recurrence, reorder, completion and deletion with an editor left open while sync changes the file. Exercise stale plugin records against the actual writer as well as shared core helpers.

### F03 — Remote binary and non-Markdown writes can overwrite intervening local edits

**Severity:** BLOCKER. **Confidence:** High. **Category:** Confirmed bug in the application write protocol; real Obsidian interleaving not yet tested. **Area:** Local filesystem application.

**Problem / why it matters:** Existing UTF-8 Markdown gets an atomic compare-and-replace callback. Other content, including editable `.canvas` and JSON files, gets a binary replacement after an asynchronous snapshot/hash check. There is no equivalent conditional write or guaranteed preserved intervening version.

**Failure sequence:** (1) Remote download checks local `.canvas` bytes against its plan. (2) Obsidian or another plugin writes new canvas content after the snapshot. (3) Crate calls `modifyBinary()` using the earlier decision and overwrites that new content. (4) The new local edit was never uploaded or copied, so remote version retention cannot recover it. The controlled local reproduction inserts the competing write at the final write boundary. Hidden adapter writes also have a concurrent-create risk.

**Files/symbols:** [applyRemoteContentIfUnchanged / writeLocalContent][local-apply], [writeBinaryContent][binary-write], [preserveLocalVersionsAndApplyRemote][preserve-local].

**Root cause:** A preflight comparison is treated as a write precondition even when the write primitive cannot enforce it.

**Recommended change:** Use the atomic text process path for supported text formats. Define an explicit safe apply protocol for binary files, with durable preimages and host-supported serialization where available; otherwise defer uncertain replacements. A second asynchronous hash check alone does not close this race. Verify actual Obsidian adapter guarantees before choosing the binary implementation.

**Proving tests:** In a real disposable vault, interleave visible/hidden Markdown, canvas, JSON and binary writes at every read/hash/write boundary, including another plugin's write and concurrent creation. Assert that every local edit is either retained in the original file, preserved durably, or produces a visible conflict. Add restart after preimage creation and before/after replacement.

## 3. Critical/high-priority findings

### F04 — Markdown serialization loses time-zone and recurrence semantics

**Severity:** CRITICAL. **Confidence:** Confirmed. **Category:** Confirmed bug. **Area:** Reminder dates, recurrence and notification times.

**Problem / why it matters:** Timed reminders are written as host-local prose without an offset or IANA zone. Parsing on another host changes their absolute time. Recurrence serialization drops its timezone and also drops `count`/`endDate` fields present in the model.

**Failure sequence:** A Berlin PWA submits `2099-07-01T07:00:00.000Z` for 09:00 local time. In UTC, the shared serializer writes `Jul 1, 2099 07:00`. Obsidian in Berlin parses that as `2099-07-01T05:00:00.000Z`: two hours earlier. This exact cross-process round-trip was reproduced. A recurrence with an explicit non-host timezone, count and end date loses those fields on Markdown round-trip. All-day notification resolution separately uses each host's `setHours`, so Worker and plugin can schedule different instants for the same date/time preference.

**Files/symbols:** [rebuildCheckboxLine][checkbox], [recurrenceToText][recurrence-text], [recurrenceCalculator][recurrence-calculator], [Worker notification datetime resolution][reminder-notifications], [ReminderNotificationService][notification-service], [recurrence request parsing][reminder-requests].

**Root cause:** Human-readable text is acting as the only durable time representation; host timezone becomes hidden domain state. The calculator can respect an explicit timezone, but storage does not preserve it. The current UI does not expose all modeled count/end-date features, which limits that part of the user impact; silently accepting/dropping unsupported fields is still unsafe contract behavior.

**Recommended change:** Store canonical machine-readable date-only/instant/recurrence-zone metadata beside readable Markdown. Preserve supported recurrence bounds or reject unsupported ones explicitly. Define timezone-change and all-day policy, and migrate old prose conservatively without inventing lost timezone information.

**Proving tests:** Browser → UTC Worker → plugin → Worker round-trips under UTC, Berlin, New York and a non-integer-offset zone; DST gap/fold days; month/year boundaries; all-day alerts; travel/timezone changes; recurrence end/count semantics; repeated completion across these boundaries.

### F05 — Reminder create and recurring completion are not retry-safe

**Severity:** CRITICAL. **Confidence:** Confirmed. **Category:** Confirmed bug. **Area:** Reminder API idempotency.

**Problem / why it matters:** Supplying the same reminder ID does not deduplicate creation. Completing a recurring reminder does not identify the occurrence being completed.

**Failure sequence:** Create commits, but the response is lost. Replaying the same body appends a second Markdown block with the identical ID. In another reproduction, completing a daily reminder advances January 1 to January 2 and resets it to incomplete; replaying the same `completed: true` request advances it again to January 3. Two clients completing the same occurrence can produce the same skip. There is no automatic offline mutation queue today, but manual retries, multiple tabs and uncertain responses still occur.

**Files/symbols:** [handleCreateReminder][reminder-create], [handleSetReminderCompleted][reminder-complete], [buildReminderCompletionPlan][completion-plan], [useReminderMutations][pwa-mutations].

**Root cause:** File CAS serializes each current transformation, but no durable operation identity or occurrence precondition connects retries to the original intent.

**Recommended change:** Add a durable operation ID/result recorded in the same metadata transaction, make create IDs unique in the reminder workspace, and require the expected occurrence/revision for recurring completion. Define replay retention and undo as distinct operations. Retrying a success must return its original outcome.

**Proving tests:** Replay create, completion, move, delete and undo after response loss; same operation from multiple tabs; same ID with different payload; recurring completion delivered out of order; duplicate replay after restart and days offline. Assert one logical creation and at most one advancement of the requested occurrence.

### F06 — An old alarm can suppress a newly scheduled notification

**Severity:** HIGH. **Confidence:** Confirmed in a controlled DO-class interleaving. **Category:** Confirmed bug. **Area:** Durable Object notification delivery.

**Problem / why it matters:** Delivery progress keys are global to the object, while schedules have tokens. The token check occurs too late to protect those keys.

**Failure sequence:** Old alarm waits for external push delivery. A PUT schedules a new occurrence and clears delivery flags. Old delivery resumes and sets `deliveryComplete = true`. The final token guard keeps the new reminder, but its flag now says delivered. Its next alarm skips sending and removes the schedule. The reproduction observes only one push across two schedules.

**Files/symbols:** [ReminderAlarm.deliverAndCleanup / fetch][alarm]. **Root cause:** Schedule-specific state is not fenced when external I/O resumes. One active DO instance does not imply arbitrary awaited external work is mutually exclusive; Cloudflare provides explicit event-concurrency controls. [Durable Object state API](https://developers.cloudflare.com/durable-objects/api/state/)

**Recommended change:** Key delivery/pending/retry state by schedule token or update it under an atomic current-token check after every external await. Avoid holding a global lock across long push requests. Preserve progress per subscription and occurrence.

**Proving tests:** Real workerd alarm + simultaneous PUT/DELETE with paused push requests; reschedule during success, partial failure and retry; restart at each durable write. A late old attempt must neither suppress nor mutate a new schedule. Do not promise exactly-once delivery across the push provider boundary.

### F07 — Notification state has competing authorities and a non-atomic outbox

**Severity:** HIGH. **Confidence:** High. **Category:** Architectural risk with concrete unchecked sequences. **Area:** Plugin/Worker/DO derived state.

**Problem / why it matters:** The plugin reconciles global server schedules against its local index and sends direct schedule/cancel calls. PWA routes commit Markdown and only then enqueue notification work. These paths are not ordered by committed reminder revision.

**Failure sequence:** A device with incomplete/stale local reminders reconciles after startup or a partial sync and cancels a server reminder it has not downloaded. Alternatively, a PWA write commits and the handler dies before enqueueing its notification. A delayed older job can also schedule after a newer job; `job_token` guards row deletion but is not a revision enforced by the DO. The local per-plugin promise queue cannot serialize different devices or Worker requests.

**Files/symbols:** [ReminderNotificationService.reconcile][notification-service], [reminder runtime callbacks][reminder-runtime], [plugin startup][plugin-lifecycle], [create route][reminder-create], [enqueueJob / processNotificationJob][outbox].

**Root cause:** Local replicas are allowed to authoritatively delete shared derived state, and the outbox is outside the source-data commit boundary.

**Recommended change:** Derive cloud schedules from committed reminder revisions. Insert the outbox intent with the file metadata commit, carry that revision through delivery to the DO, and reject obsolete work. Reconciliation should repair from committed server data; a local snapshot should not cancel unseen remote reminders. Give expired/unrecoverable outbox work a terminal state and user-visible recovery.

**Proving tests:** Partial bootstrap followed by reconciliation; file upload failure after local completion; crash between Markdown commit and enqueue; old schedule after new cancel; old cancel after new schedule; two devices with different timezone preferences; due date passes while outbox retries.

### F08 — Concurrent successful PWA mutations overwrite each other's cached results

**Severity:** HIGH. **Confidence:** Confirmed. **Category:** Confirmed bug. **Area:** PWA optimistic state.

**Problem / why it matters:** Success handlers reconstruct the entire list from a snapshot taken before the request. Read-request fencing does not merge simultaneous mutations.

**Failure sequence:** Start completion of reminders A and B. B's response marks B complete. A's later response commits its old whole-list snapshot with only A changed, restoring B to incomplete in UI/cache although both server requests succeeded. This was reproduced against the actual hook with controlled responses. A later user action based on the false state compounds F05.

**Files/symbols:** [useReminderMutations][pwa-mutations], [useReminderSync.commitReminderState][pwa-sync]. **Root cause:** Snapshot replacement instead of revision-aware per-entity reconciliation.

**Recommended change:** Apply returned entities to the current store, reconcile project changes independently, and track pending mutations by entity/operation. Roll back only fields owned by the failing operation. For operations that reorder a shared list, use a list revision or serialization boundary.

**Proving tests:** Reverse-order successful edits to different reminders, mixed success/failure, same-reminder edits, create/delete interleavings and reorder; assert the visible list and persisted snapshot converge to server state without requiring manual refresh.

### F09 — Failed saves discard PWA editor drafts

**Severity:** HIGH. **Confidence:** Confirmed in Chromium and source. **Category:** Confirmed bug. **Area:** PWA offline/error recovery.

**Problem / why it matters:** Save closes the editor before awaiting the request. On failure, it restores list state and shows a toast but neither restores the draft nor persists it.

**Failure sequence:** User writes a new title/description while online; connectivity fails during Save. Modal closes, request rejects, old card returns, and reopening the editor shows the old title. The entered draft is gone. Chromium reproduction used the actual built PWA and an aborted update request.

**Files/symbols:** [saveReminder][pwa-mutations]. **Root cause:** Optimistic dismissal has no durable draft lifecycle.

**Recommended change:** Retain the draft until acknowledgement, offer retry/reopen after failure, and persist unsent drafts under the authenticated session. First fix operation idempotency so retry is safe. The current intentionally read-only cached mode can remain; a full background mutation queue is not required to fix draft loss.

**Proving tests:** Network failure before/during/after commit, 409, 401, tab kill and browser restart while saving. Keep entered fields recoverable and show whether the save is pending, failed or confirmed. Repeat in real iOS Home Screen Safari as well as desktop engines.

### F11 — Joining an existing server can downgrade its Worker

**Severity:** HIGH. **Confidence:** High from direct call tracing. **Category:** Confirmed bug in deployment control flow; no live deployment performed. **Area:** Multi-device provisioning.

**Problem / why it matters:** OAuth connection to a discovered server unconditionally provisions the plugin's embedded artifacts. The update-notice comparison that suppresses downgrade suggestions is not a guard on this path.

**Failure sequence:** Device A upgrades the server to a newer release. Device B still has an older plugin and connects through discovery. `handleCallback()` selects the existing metadata and calls the provisioner; it uploads B's older Worker/PWA after reconciling the database. This can put older code against newer schema and affect every device.

**Files/symbols:** [CloudflareDeploymentService.handleCallback][deployment], [provisionCloudflareDeployment][provisioner], [isCloudflareServerUpdateAvailable][deployment-update]. **Root cause:** Joining/registering a device and deploying server code share an unconditional operation.

**Recommended change:** Make existing-server join register the device without changing artifacts. Require an explicit deployment intent and compare authoritative remote deployment identity before upload. Reject downgrades unless a separately supported rollback procedure is invoked.

**Proving tests:** Old/new plugin permutations, discovery with newer metadata, stale locally saved metadata, concurrent joins and concurrent updates. Assert joining never calls `uploadWorker`; test explicit safe upgrade and rejected downgrade using the provisioner boundary.

### F12 — Compatibility is advertised but not enforced throughout normal operation

**Severity:** HIGH. **Confidence:** High. **Category:** Architectural risk / missing protection. **Area:** Protocol, schema and PWA rollout.

**Problem / why it matters:** The server advertises protocol current/oldest values, but the client comparison lives in `testConnection()`, not a mandatory write handshake. Reminder requests have no negotiated schema revision. A PWA update banner is not a compatibility gate.

**Failure sequence:** An old PWA remains open through multiple releases and continues writing its old request shape to new handlers. A stored plugin connection resumes without re-negotiation. Meanwhile the service worker activates immediately, retains one prior shell cache, and can remove lazy chunks needed by an older open client after another release. The exact future incompatibility depends on the schema change, so this is a design risk rather than a demonstrated current version-2 interop failure.

**Files/symbols:** [protocol definition][protocol], [SyncWorkerApi.testConnection][connection], [engine initialization][engine-lifecycle], [service-worker lifecycle][service-worker], [usePwaUpdate][pwa-update], [initializeD1Schema / provisioning][provisioner], [migration 0002][migration].

**Root cause:** Version information does not constrain the mutation boundary or asset lifetime. Upgrade tests primarily initialize the current schema; the provisioner migration tests use mocked D1 responses. Migration 0002 also backfills `portable_path` with SQLite `lower(path)`, whereas new writes use Unicode normalization and JavaScript lowercasing. Those are different normalization rules for non-ASCII paths.

**Recommended change:** Negotiate supported request/storage versions on startup and enforce them on every mutation. Use additive migrations and a documented compatibility window; freeze incompatible clients while preserving drafts. Retain assets for active supported client versions or require a safe reload before loading removed chunks. Exercise legacy Unicode paths during migration using the same portable-key algorithm as writes.

**Proving tests:** Old frontend/current backend, current frontend/old backend, open tab spanning three releases, lazy editor after upgrade, crash at every migration step, concurrent old writes during migration, and real D1 fixtures containing composed/decomposed Unicode and case collisions. Verify explicit rejection and safe resumability, not just a rendered update banner.

### F13 — Hash-only delete preconditions permit delete/recreate ABA

**Severity:** HIGH. **Confidence:** Confirmed. **Category:** Confirmed bug. **Area:** File identity and operation ordering.

**Problem / why it matters:** A content hash identifies bytes, not a file incarnation. A delayed old delete can match a newly recreated same-content file.

**Failure sequence:** Upload `note.md` with hash H; delete with expected H succeeds; another client deliberately recreates `note.md` with the same bytes; replay the earlier delete with expected H. It succeeds and removes the new incarnation. The Worker reproduction confirms this. Retained versions mitigate recovery, but the deletion still propagates contrary to the new intent.

**Files/symbols:** [handleDelete][delete], [commitFileDelete][delete-commit], [protocol file models][sync-types]. **Root cause:** Content equality substitutes for generation equality; deletion has no durable operation replay identity.

**Recommended change:** Add a monotonic file revision/incarnation precondition and replay protection, retaining hashes for integrity. Preserve a tombstone/generation sufficient to distinguish recreation after absence. Specify delete/edit and delete/recreate separately.

**Proving tests:** Replay old delete/upload after delete-and-recreate with identical and different bytes, out-of-order operations across three devices, and replay after changelog expiry. A retry of the old operation must not affect the new incarnation.

### F14 — One oversized reminder project can make the entire PWA workspace unreadable

**Severity:** HIGH. **Confidence:** High from implementation. **Category:** Confirmed limit mismatch. **Area:** Reminder indexing/API availability.

**Problem / why it matters:** Sync and Markdown writes accept files up to the general 25 MiB limit, but list rejects the whole folder if any Markdown file exceeds 1 MiB. A separate 1.5 MiB parsed-cache limit can reject a smaller source file. Growth can turn a previously valid workspace into an all-or-nothing error.

**Failure sequence:** A project accumulates reminders or a user syncs a 1.1 MiB Markdown document under the adopted folder. Upload succeeds. Every subsequent reminder list for that folder returns 413, including requests for otherwise healthy projects. The PWA cannot use the accepted data until the vault file is split or reduced.

**Files/symbols:** [handleListReminders][reminder-list], [cache limits][cache-limits], [cache persistence][server-cache-persist], [writeCommittedMarkdownFile][markdown-write]. **Root cause:** Storage, parser and UI contracts have different limits, with no partial workspace result.

**Recommended change:** Publish and enforce consistent write/index limits or partition indexing so a single file cannot block unrelated reminders. Return explicit per-project errors/partial state with recovery guidance. Preserve existing data rather than automatically truncating it.

**Proving tests:** Files just below/above 1 MiB and 25 MiB, a small source that expands beyond cache limits, mixed healthy/oversized projects, and a create that crosses the threshold. Test both plugin uploads and PWA mutations.

### F15 — The candidate fails its release gates

**Severity:** HIGH. **Confidence:** Confirmed. **Category:** Missing protection/test maintenance. **Area:** Release verification.

**Problem / why it matters:** The checked-out candidate cannot pass `release:check`, because its baseline unit suite fails. The separate browser suite also fails and is not included in that release command.

**Concrete failure:** Two expectations in [remindersLayoutStyles.test.ts][layout-tests] and one in [worker/pwa.test.ts][pwa-tests] fail. The browser focus script selects an Inbox fixture without opening Inbox; the explicit route passes. The UI performance script's 85-pixel gesture no longer crosses the damped threshold; a larger gesture reaches a layout assertion that also fails in its isolated harness. These are verification failures, not evidence by themselves of broken physical-device keyboard or layout behavior.

**Files/symbols:** [package scripts][package], [focus browser test][focus-test], [UI performance script][ui-test], [release workflow][release-workflow]. **Root cause:** UI implementation and harness expectations drifted; CI does not run the full PWA browser sequence.

**Recommended change:** Reconcile test expectations with intended UI behavior after inspecting the real layout, then run deterministic browser checks in CI with required browser installations. Do not merely delete failing assertions. Run exact release assets through the existing physical-device checklist.

**Proving tests:** A fresh locked install passes release checks on all declared Node versions, browser cache/focus/UI suites on Chromium and WebKit, and exact artifact hashes match across the release matrix. Record a completed release checklist for this candidate.

Other substantive findings—F10 session privacy, F16 bounded-resource risks, F17 authorization scope, F18 recovery/observability and F19 supply-chain hygiene—are documented in their corresponding assessment sections below using the same evidence standard.

## 4. Sync correctness assessment

### What actually happens

The source of local edits is the vault. [SyncRuntime][sync-runtime] captures events, queues paths with local queue revisions, debounces bursts and schedules foreground/periodic reconciliation. [SyncEngine][engine] serializes workflows and delegates planning/transfers. [LocalManifest][manifest] records the last accepted file hashes/metadata and changelog cursor. Queue state is in memory; surviving file changes are rediscovered after restart.

Remote bytes are staged under immutable hash/UUID keys in R2. D1 `files` maps logical paths to those keys. Conditional D1 mutations, changelog rows and retained-version rows are batched together. Reads resolve through committed metadata and validate returned content. Full manifests are paginated and followed by changelog replay; incremental sync uses a server sequence rather than device timestamps. Expired cursors fall back to full reconciliation. This is appropriate for devices offline for weeks, provided the previous local manifest remains trustworthy.

Normal reconciliation compares local current, last-synced base and remote current hashes. Independent Markdown changes can merge using a hash-verified cached base. Overlapping changes preserve the local side in a conflict copy and put the remote side at the original path. Conflict copies are intentionally excluded from sync. Edit/delete races use an explicit edit-wins policy. Renames are a delete plus an add, not a transaction with a stable file identity. [Shared classification][reconciliation], [merge implementation][markdown-merge], [event queue][queue], [conflict handling][conflict].

Initial upload prepares bounded chunks. Joining an existing vault through normal sync reconciles remote and local state. Force full sync snapshots the manifest, uploads local data before deleting remote-only paths, and suppresses remote deletion when upload work fails/aborts. It is an explicit local-authoritative operation, not a repair for an unexplained missing note.

### Concrete multi-device behavior

| Scenario | Current behavior and practical consequence |
|---|---|
| A and B edit the same Markdown note offline | First accepted write changes remote. Second reconciles against the shared base: disjoint edits merge; overlap becomes a local conflict copy. The surviving original converges, but the conflict copy is local-only. F01/F03 qualify the storage/apply guarantees. |
| A edits while B deletes; reverse arrival order | Edit wins. A remotely deleted but locally edited file is re-uploaded; a locally deleted file with a remote edit is restored. This intentional resurrection preserves content but can surprise the deleting user. |
| A renames while B edits | New name receives A's snapshot; the edit can survive at the old name under edit-wins. Both paths may remain. No automatic semantic rename-following guarantee. |
| A and B rename to different destinations | Both destination files can survive and the original disappears. This duplicates logical content because the protocol only sees paths. |
| Delete then recreate | Different content usually triggers replan/conflict; identical content allows a delayed stale delete through F13. |
| Three devices update related files | Per-file CAS prevents several stale writes, but there is no cross-file transaction for generic renames or related-note consistency. The third writer can cause bounded replan exhaustion and retry. |
| PWA edits after plugin update | Full-form stale fields can overwrite newer data (F02), even though file CAS succeeds correctly. |
| Request succeeds but response is lost | File retries can be idempotent by hash when storage is intact; reminder create/recurrence retries are not (F05). An uncertain D1 response inside the Worker triggers F01. |
| Client dies during apply/checkpoint | Main/temp generations and persistent file bytes support re-reconciliation. There is no all-vault atomic apply; a restart must tolerate a partially applied set. Binary preimages are not guaranteed (F03). |
| Weeks offline with expired changelog | Full manifest reconciliation replaces cursor replay. Lost common bases reduce merge quality; retained versions older than 30 days may be gone. |

### Critical invariants

| Invariant | Enforcement today |
|---|---|
| Every live and retained metadata reference resolves to correct immutable bytes | Hash/size checking and immutable keys help; **violated by F01**. No foreign key can enforce an R2 reference. |
| A stale file writer cannot replace an unrelated newer version | D1 hash CAS largely enforces this; hash ABA remains F13. |
| Every local edit is preserved before remote application | Atomic process callback for existing valid UTF-8 Markdown; **not enforced for binary/non-Markdown F03**. |
| A mutation only changes the reminder fields/occurrence the user edited | **Not enforced**, F02/F05. |
| Cursor acknowledgement does not skip unapplied work | Workflow/checkpoint and abort handling have focused tests; still needs real crash/interleaving coverage across adapters and bindings. |
| One portable logical path maps to one remote file | Validation plus unique portable-path index; legacy migration normalization requires F12 work. |
| Replaying an accepted intent has no new effect | Partial file support; **not general**, F05/F13. |
| Notification state corresponds to the newest committed reminder | **Not enforced**, F04/F06/F07. |
| Time meaning survives every client's serialization | **Violated**, F04. |

The local manifest's generation-based main/temp selection, hash validation of merge bases, bounded CAS retries and trash-based local deletion are valuable protections. Corrupt/missing manifests fall back toward reconciliation rather than treating a blank local view as authority to delete the server. Hash+mtime optimizations still assume unchanged mtime/size means unchanged bytes; external tools preserving both can delay detection. An occasional integrity audit is appropriate for high-confidence sync diagnostics.

## 5. Sync threat model

Trusted components include the user's vault process and plugins, authenticated Crate clients, the Worker code and the owner's Cloudflare account. Devices and browser tabs can be stale, interrupted or mutually unaware; requests can duplicate/reorder; service calls can have uncertain results. A compromised owner account or vault-scoped credential can intentionally modify vault data—Crate is not designed to contain a malicious owner-level writer.

| Threat | Protection now | Remaining exposure |
|---|---|---|
| Loss of the latest cloud file | Immutable staging and old-version retention | F01 deletes newly committed bytes; a new file may have no older version. |
| Overwrite of a newer local edit | Hash validation, Markdown atomic callbacks | F03; retained remote versions cannot recover a never-uploaded local edit. |
| Silent reminder-field corruption | Stable IDs and file CAS | F02; identity is not freshness. |
| Content corruption in transit/storage | SHA-256/size verification; fail on unavailable object | Detects corruption but does not reconstruct missing bytes. Restores must verify and copy to a new key. |
| Duplicate reminders/skipped occurrences | Some absolute-state operations are naturally idempotent | F05; same-ID create and recurring completion replay. |
| Deleted content resurrects | Edit-wins deliberately preserves concurrent edits | Expected policy, but UI must distinguish it from delete failure; rename races can leave extra paths. |
| New recreation deleted by an older request | Expected-hash CAS | F13 when bytes match the old incarnation. |
| Device divergence | Shared classification, deterministic merging, cursor fallback | Local-only conflict copies, partial workflows, non-atomic rename, F01/F03/F13. |
| PWA/Obsidian disagreement | Shared Markdown domain modules | F02/F04/F07/F08; current cache/schedule state can diverge despite common code. |
| Crash during persistence | Temporary manifest generations; IDB transactions | Real host crash matrix incomplete; no durable PWA save draft (F09). |
| Old client damages new state | Advertised protocol versions | F11/F12; no universal mutation gate or supported rollback contract. |
| Unrecoverable deletion/account loss | Local trash and 30-day remote versions | Same-account retention is not an independent backup; incomplete disaster recovery/diagnostics, F18. |

Threat priorities should follow recoverability. Conflict copies are inconvenient but usually preserve content. A confirmed successful mutation pointing to deleted bytes is much more serious. Avoid flattening both into a generic “sync error.”

## 6. Architecture assessment

The major boundaries are sensible. The small [main entry][main] delegates lifecycle to the plugin; sync has separate planning, queue, transfer and reconciliation modules; Worker storage is separate from HTTP routing; PWA shares reminder parsing and UI rather than duplicating the entire domain. R2 stores content, D1 stores metadata, and Durable Objects handle per-reminder alarms. There is no need to introduce another database, CRDT framework, broker or service layer merely for architectural symmetry.

The most valuable structural changes are specific:

1. **Centralize staged-object commit and cleanup policy** in the Worker storage boundary. Move the repeated uncertainty handling out of HTTP handlers and reminder writers. Keep conditional SQL and retention decisions together. F01 demonstrates that duplication here has already produced inconsistent safety guarantees.
2. **Make a shared reminder mutation contract** for expected revision, changed fields, operation ID and expected occurrence. Keep parsing, Markdown block construction and recurrence rules together; let each storage adapter implement atomic commit. Shared code alone does not fix timezone-dependent behavior (F02/F04/F05).
3. **Make notifications a revisioned projection of committed data.** Consolidate ownership instead of allowing every local index to repair global state independently (F07). Keep the DO as the delivery mechanism.
4. **Separate joining from deploying** in the Cloudflare service. This is a responsibility boundary with a concrete downgrade consequence (F11).
5. **Make PWA mutations/session generations explicit in the state layer**, keeping optimistic patches, persistence and acknowledgement together (F08–F10). This is more useful than splitting `main.tsx` only because it is 374 lines.

`SyncEngine` is 487 lines, but already delegates much of its behavior. Further extraction should follow a demonstrated ownership problem, not a line-count rule. The current folder structure does not need a broad rewrite. A single Worker deployment/D1/R2 account is the deliberate availability and trust boundary; the OAuth publisher is an additional setup dependency, while already connected sync does not require central publisher availability.

## 7. Cloudflare/backend assessment

The selected primitives fit a personal vault deployment. Worker HTTP routes are stateless; D1 supports ordered metadata transactions and queries; R2 is appropriate for note/attachment bytes; one Durable Object per reminder is reasonable for alarms. Notification jobs and object cleanup are D1-backed work lists drained by cron. No KV, Cloudflare Queues or WebSocket replication layer is involved in the primary flow.

R2 provides strong consistency for direct writes/reads/deletes; this design does not need an eventual-consistency explanation for missing newly committed objects. F01 is application cleanup destroying them. Strong object consistency also does not create a transaction with D1. [R2 consistency documentation](https://developers.cloudflare.com/r2/reference/consistency/)

D1 batches appropriately bind metadata/changelog/version updates. Current code uses ordinary bindings rather than a read-replica session; inventing a replica-lag bug would be incorrect. If read replication is introduced later, session bookmarks must preserve the assumed read ordering. [D1 binding and sessions documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/)

| Failure | Current likely behavior / needed guarantee |
|---|---|
| R2 staging unavailable | Mutation should fail before publishing metadata; retry must preserve previous content. |
| D1 unavailable before commit | Staged garbage may remain; safe delayed cleanup is acceptable. |
| D1 response lost after commit | F01; must treat outcome as uncertain. Cloudflare explicitly documents transient write-query failures/retries. [D1 retry guidance](https://developers.cloudflare.com/d1/best-practices/retry-queries/) |
| R2 content missing/corrupt on read | Return unavailable/integrity error, not a valid empty file. Repair needs a known-good version. |
| DO or push service unavailable | Outbox/alarm retries provide recovery, subject to F06/F07 and deadline handling. |
| Cron fails or is disabled | Retention expiry, orphan cleanup and failed notification reconciliation stall; expose age/backlog and alert. |
| Account deleted or credential compromised | Same-account versions cannot be the disaster-recovery boundary (F18). |

Migrations have a ledger and provisioner support, but require real old-schema/resume tests and a safe deployment compatibility window (F12). Do not roll back only D1 after GC has deleted objects referenced by the older snapshot. Rebuild derived reminder indexes and schedules from verified source data after recovery.

## 8. Obsidian plugin assessment

The entry shell, lifecycle delegation, listener registration, watcher cleanup, abort propagation and settings normalization show deliberate Obsidian integration. Startup waits for layout and coordinates the initial sync; tests cover unload/startup/event recovery. Visible files use vault APIs; hidden paths use the adapter; plugin directories and local recovery files are excluded from sync, reducing feedback loops and credential/plugin-code propagation. Settings and sync history are bounded separately from the file manifest.

Own-write events and overlapping queue changes are handled with revisions and replanning instead of blindly clearing a path. Existing Markdown process callbacks compare the actual text at the write boundary. Local deletes use configured/local trash, without falling back to permanent removal when trash fails. The remaining hash-check/trash race is recoverable in trash; it should not be reported as equivalent to F03's unpreserved overwrite.

The strongest plugin-specific concerns are F02's stale reminder record, F03's binary apply, and F07's local authority over global schedules. The PWA and plugin use the same domain functions but run in different timezone environments, making F04 a plugin problem too.

I found no basis to claim a general event-listener leak from the reviewed lifecycle. Actual shutdown during in-flight HTTP still needs host testing: cancellation stops local handling but cannot guarantee a server mutation did not commit. Cross-platform minimum-version verification remains a release gate, since adapter/process semantics and native file event ordering are not proven by TypeScript mocks. The current release checklist already calls for desktop, physical iOS and Android verification; complete it rather than treating browser WebKit as iOS Obsidian.

## 9. PWA assessment

The current offline contract is **cached read-only access**, not offline mutation replay. Live snapshots are persisted in IndexedDB with migration/normalization logic. The read coordinator rejects superseded responses and avoids applying reads over local mutations. Cache migration, metadata refresh, revision guards and clearing passed existing Chromium/WebKit tests. These are useful protections; they do not cover concurrent mutation result merges or session-wide fencing.

The service worker precaches the application shell/assets and restricts its cache handler to those routes. `/reminders/list` private API data is not generically cached in Cache Storage; private reminder snapshots are intentionally persisted separately in IndexedDB. An existing cached shell can work offline, while F12 governs whether it can safely keep talking to a changed backend.

### F10 — Logout does not invalidate other tabs or all in-flight work

**Severity:** MEDIUM. **Confidence:** Confirmed for visible cross-tab residue in Chromium; High for late-write risk. **Category:** Confirmed bug / missing session protection. **Area:** Browser session privacy.

**Problem / why it matters:** Logout clears the invoking component tree and shared local credential/cache, but other open tabs keep their in-memory session and reminder list. No cross-tab session broadcast/storage listener invalidates them. Mutation callbacks are not fenced by a session generation.

**Failure sequence:** Two tabs display the same reminders. Log out in tab A; the shared token is removed, but tab B still visibly displays the private reminder. A request already accepted before logout can also complete afterward and attempt to repopulate state/cache. The browser reproduction proves the first behavior against the preview server; it does not establish a production server revocation bypass. Remote token revocation should reject subsequent requests, but cannot erase another tab's memory.

**Files/symbols:** [performPwaLogout / clearLocalSession][session], [useReminderSync][pwa-sync], [useReminderMutations][pwa-mutations], [reminder-cache.ts][pwa-cache]. **Root cause:** Component-local invalidation without cross-tab/session-generation ownership. Remote cleanup is awaited before local cleanup, so a hanging request can delay local logout.

**Recommended change:** Clear/lock local state promptly, broadcast logout, bind snapshots and asynchronous completions to a session generation, and ignore late responses from the old generation. Bound network cleanup and report remote revocation failure separately. Ensure closing IDB connections and clearing data is repeatable across tabs.

**Proving tests:** Two tabs plus an installed window; logout with delayed reads/mutations; offline/hanging revocation; login as a different credential on the same origin; tab wake after hours suspended; assert no old content reappears in UI or IndexedDB.

Push delivery uses subscription validation, encrypted Web Push payloads, bounded delivery concurrency, expired-subscription pruning and notification tags. F04/F06/F07 remain correctness gaps. Notification permission denial or browser suspension must be displayed as delivery availability, not as evidence that note sync failed. Physical Safari/Home Screen checks are essential: iOS/iPadOS Web Push requires a supported Home Screen web app and user-gesture permission flow. Desktop WebKit automation does not prove installation, OS delivery or keyboard behavior. [WebKit platform requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

## 10. Security assessment

The deployment is a **single-owner, single-vault trust domain**, not a multi-tenant SaaS. No verified cross-account data exposure or unauthenticated arbitrary vault read was found. Absence of tenant columns is appropriate only under that documented boundary.

Positive controls include OAuth state + PKCE, short-lived in-memory authorization material, revocation of the temporary deployment token, hashed high-entropy device/session credentials, route scopes, input size limits, path validation, portable-name checks and parameterized SQL. Reminder rendering constructs DOM rather than treating arbitrary user prose as trusted HTML. CSP and explicit bearer authentication provide useful defenses. Wildcard CORS alone is not a cookie-based CSRF vulnerability here. README clearly discloses Cloudflare processing, optional push payloads, browser persistence, lack of end-to-end encryption and the need for independent backup.

### F17 — Reminder credentials are not bound to the configured folder; push enrollment is broadly capable

**Severity:** MEDIUM. **Confidence:** Confirmed for folder scope; High for abuse surface. **Category:** Architectural risk / missing least-privilege protection. **Area:** Authorization and outbound requests.

**Problem / why it matters:** The reminders scope restricts route names, but the caller supplies `folderPath`; it is not an authority stored on the principal. Push subscription validation accepts HTTPS endpoints without restricting them to a validated provider policy, and subscription count/request rate are not bounded at the application boundary.

**Failure sequence:** A reminders-scoped principal requests `folderPath=Private` rather than the configured Reminders folder and receives a marked checkbox from `Private/Personal.md`; this reproduced through the authenticated router. Only recognized marked reminder content is exposed by that scenario, not arbitrary whole-file download. A holder able to enroll subscriptions can register a chosen HTTPS endpoint and keys, causing outbound encrypted notification requests to that endpoint and adding delivery work.

**Files/symbols:** [scope route allowlist][router], [workspace parsing][reminder-requests], [notification subscription handlers][notification-handlers], [Web Push sender][web-push]. **Root cause:** UI folder selection is not an authorization boundary; endpoint syntax validation is not an abuse-control policy.

**Recommended change:** Decide and disclose whether reminder credentials intentionally authorize every marked reminder in the vault. Prefer binding them to the adopted folder/workspace. Bind enrollment grants to that scope, cap subscriptions, add per-credential/enrollment rate limits and request deadlines, and validate redirects/endpoint policy. Do not describe this as proven cross-user compromise; severity is limited by the existing same-owner trust domain and required credential.

**Proving tests:** Scope mismatch, caller-selected folder, traversal and Unicode edge cases, scope changes after token issuance, subscription floods, arbitrary endpoint/redirect attempts, provider timeout, and revoked/expired enrollment replay.

### F19 — Development dependency and release supply-chain hygiene needs attention

**Severity:** MEDIUM. **Confidence:** Confirmed. **Category:** Missing protection. **Area:** Dependencies, CI and accidental secret publication.

**Problem / why it matters:** `npm audit` reports high advisories in transitive `browserslist` and `fast-uri`, and a moderate advisory in `@humanfs/node`; fixes are available. `npm audit --omit=dev` reports none. CI actions use mutable major tags; the release job grants publishing/attestation permissions to a job that also installs/builds dependencies. `.gitignore` does not exclude `.env` files.

**Concrete scenario:** A future local `.env` can be accidentally staged, or a compromised action/development dependency can execute in a release job. These are exposure paths, not evidence that this repository or its artifacts are compromised. The dependency audit does not establish that each advisory is reachable in Crate's build inputs.

**Files/symbols:** [package/lockfile inputs][package], [release workflow][release-workflow], [.gitignore][gitignore], [audit results][evidence]. **Root cause:** Preventative supply-chain/secret controls lag behind a mature release workflow.

**Recommended change:** Update the affected transitive packages through a reviewed lockfile change, pin action revisions, split build verification from privileged publishing where practical, set minimal job permissions, add dependency update automation, ignore real `.env` files while allowing an example, and add a proper secret scanner to CI/history review.

**Proving tests:** Fresh locked install, notices and reproducible artifact checks; re-run full/production dependency audits; verify CI permission boundaries and scanner fixtures. No actual credentials should be used in scanner tests.

The history scan found no matches for its private-key, recognizable GitHub/Slack/AWS-token and long literal-secret assignment patterns and no sensitive filenames in the scanned refs. It was not a entropy-based or vendor-backed scan. Security-sensitive Web Push encoding/crypto deserves independent protocol vectors; do not replace it casually based only on dependency count. Third-party notices, license metadata and release provenance checks already exist; no concrete incompatible bundled license was identified by this audit.

## 11. Missing test matrix

“Partial” means useful existing tests exist but do not prove the full distributed/host scenario. In particular, [reconciliation-state-machine.test.ts][state-machine] exercises the real classifier through a simplified in-memory server, not the production network/storage/write stack. “Reproduced” refers to added audit evidence, not an existing passing safety regression.

| Scenario | Adequately protected today? | Required assertion / next test |
|---|---|---|
| A edits / B edits | Partial: classifier, merge and CAS tests | Real two-client full pipeline preserves every edit or a durable conflict copy; both orders converge. |
| A edits / B deletes | Partial: edit-wins state-machine coverage | Commit/delete race at binding and local adapter boundaries; edited bytes survive. |
| A deletes / B edits | Partial: inverse ordering covered in model | Restore remote edit with explicit resolved-race UX; deletion never erases newer bytes. |
| A renames / B edits | Partial: model covers retained outcomes | Real queued delete/add, crash between operations; old/new paths and copies match documented policy. |
| A renames / B renames | Not demonstrated end-to-end | Both destinations survive or a declared conflict resolves them; no silent drop. |
| Delete / recreate | **Unsafe: F13 reproduced** | Same-hash incarnation and delayed delete/upload cannot affect the recreation. |
| Three-device concurrency | Not demonstrated through real stack | Random scheduling across paths, retries and partial responses; safety plus eventual convergence. |
| Plugin / PWA concurrency | **Unsafe: F02 reproduced** | Stale field/occurrence revisions rejected or correctly merged. |
| Long offline periods | Partial: expired-cursor/full fallback tests | Advance beyond retention; preserve offline edits; missing base becomes safe conflict. |
| Network failure before request | Partial: HTTP/queue tests | No acknowledged mutation; local source/draft survives and retry remains pending. |
| Network failure during request | Partial: cancellation/timeout tests | Unknown commit outcome is reconciled; no cursor advance over unapplied work. |
| Network failure after server commit | **Unsafe: F01/F05 reproduced** | All mutation families survive lost acknowledgement and replay without new effect. |
| Duplicate requests | Partial for files; unsafe for reminders | Same create/complete/move/delete operation has one logical result. |
| Out-of-order requests | Partial hash CAS; domain gaps | Enforce file generation, reminder base and notification revision. |
| Client crash during sync | Partial: manifest/conflict recovery | Kill between download/write/checkpoint; restore all bytes and replay safely after restart. |
| Backend crash/failure during sync | Restore has strong real tests; other paths unsafe | Fault each R2/D1/cleanup boundary; no live dangling reference. |
| Local persistence corruption | Partial: manifest/base/cache validation | Truncated main+tmp, bad hash, invalid IDB record and quota failure; preserve vault data and expose repair. |
| Migration failure | Provisioner mocks; browser cache migration tests | Real legacy D1 schema, partial DDL, interrupted retry and Unicode collision; multi-tab IDB version upgrade. |
| Old client / new backend | Insufficient | Golden old clients cannot submit incompatible writes or downgrade server. |
| Multiple PWA tabs | **Logout residue reproduced; stale-write risk** | Session broadcast, late response fencing, same-reminder edit and concurrent mutations. |
| Service-worker version mismatch | Limited shell/cache tests | Keep tab through three releases; load old lazy chunk, save draft, update/reload safely. |
| Local file changes during remote apply | Markdown has focused protection; F03 remains | Real Obsidian visible/hidden text and binary write interleavings. |
| Recurring reminder duplicate completion | **Unsafe: F05 reproduced** | One occurrence advances once across tabs/retries/restart. |
| Timezone / DST | Calculator tests; round-trip broken | Shared serializer through different TZ processes plus all-day/recurrence payloads. |
| Notification reschedule during delivery | **Unsafe: F06 reproduced** | Real DO event interleaving cannot modify newer schedule progress. |
| Notification source commit / outbox failure | Insufficient | Source commit and outbox intent atomic; obsolete jobs fenced. |
| PWA offline save / crash | Cached mode covered; F09 reproduced | Entered draft survives request loss, dismissal and browser kill. |
| Logout/cache privacy | Single-session/cache clearing covered | Already-open tabs and in-flight mutations cannot restore private data. |
| Plugin unload/reload/vault events | Good mocks; host coverage incomplete | Disposable real vault across minimum Obsidian, desktop/iOS/Android, repeated enable/disable. |
| 1k/10k notes, thousands of reminders | Budget tests, no representative benchmark here | Peak memory, p95 latency, request/D1 counts and eventual maintenance drainage. |
| Security regression | Validation/auth tests exist | Object scope, endpoint abuse, malicious reminder text, path fuzzing and scanner fixtures. |

Use a deterministic scheduler/failure injector around the **real** planner, transport, Worker bindings and vault adapter. Randomly generate edit/delete/recreate/rename/retry/crash sequences and assert byte preservation, reference integrity, monotonic acknowledgement, idempotence and eventual convergence. Keep failing seeds as small regressions. Coverage percentage is not the missing release signal.

## 12. UI/UX assessment

Implementation strengths include explicit live/cached/error states, cache-age/status copy, persistent conflict notices, activity history, destructive-operation confirmation, touch-oriented sheets, labeled reminder cards and keyboard entry points. Focus behavior passed on both desktop browser engines once the fixture opened the correct tab. These are meaningful usability investments.

The priority is making data state truthful:

| User question | Current limitation | Required behavior |
|---|---|---|
| “Was my edit saved?” | Optimistic dismissal and F08/F09 can misrepresent or lose it | Show pending until acknowledgement; preserve a failed draft and safe retry. |
| “Which version won?” | Conflict copies preserve data, but originals favor remote and copies remain local | Explain the original, preserved local copy, merge outcome and next action together. |
| “Why did a deleted file return?” | Edit-wins is recorded as a resolved race, without a conflict notice | Explain restoration due to another edit in activity and file context. |
| “Is every file synced?” | Oversized files can be skipped during preparation; success counts do not always expose them | Persistent excluded/too-large count with affected paths and reason. |
| “Why did my reminder fire at another time?” | F04 and competing scheduling authority | Display an explicit timezone policy and last confirmed schedule state. |
| “Can I safely retry?” | Generic errors do not distinguish unknown commit from rejection | Classify pending/unknown/rejected/committed and attach operation identity. |
| “Did logout clear this device?” | Other open tabs retain data (F10) | Clear every session surface promptly and report remote cleanup separately. |

Do not infer physical-device accessibility or layout correctness from CSS substring tests. After reconciling F15, verify screen-reader labels, focus trapping/restoration, keyboard-only navigation, touch targets and safe areas in the built app and Obsidian themes, including high zoom and long titles. The failing isolated pull-layout assertion is a test/implementation disagreement requiring inspection, not a basis for asserting every production list visibly jumps.

## 13. Performance/scalability assessment

### F16 — Bounded individual work still leaves workspace and maintenance scaling gaps

**Severity:** MEDIUM. **Confidence:** High for bounds/calculations; Medium for unmeasured device impact. **Category:** Architectural risk / missing protection and performance test. **Area:** Large vaults, reminder indexing, cleanup and reporting.

**Problem / why it matters:** Transfer chunks and per-request limits are bounded, but whole-workspace work, notification reconciliation and maintenance throughput can outgrow those bounds. Oversized local files are filtered/skipped on some paths without a persistent user-visible incomplete-sync state.

**Concrete scenarios:** At six small files per initial upload batch, 10,000 files require roughly 1,667 upload calls before other traffic. A cold reminder folder with 1,000 small Markdown files needs at least 50 twenty-file warmup requests; the client's 15-second total retry-delay budget permits about 16 requests with the server's one-second delay, so the first load errors before warming finishes. Cron drains 25 cleanup keys per 15 minutes: 2,400/day when every run succeeds. Expiration arriving faster than that grows retained garbage. Notification reconciliation starts all schedule/cancel promises at once. These are source-derived limits, not a measured claim that a particular device crashes.

**Files/symbols:** [transfer budgets][transfer-budget], [sync limits][sync-limits], [file discovery][file-discovery], [prepare uploads][transfer-prepare], [cache limits][cache-limits], [fetchReadyReminderList][reminder-api], [reconcile][notification-service], [cleanup queue][cleanup], [orphan sweep][orphan-sweep].

**Root cause:** A bounded batch is not an end-to-end resource budget or a sustainable drain rate. UI completion also lacks a consistently modeled “some files cannot sync” outcome.

**Recommended change:** Keep current bounded transfer strategy; measure representative workloads before changing batch sizes. Make reminder warmup resumable with progress/partial results, bound scheduling concurrency, drain cleanup adaptively within platform budgets, and expose backlog age. Track skipped files as persistent incomplete sync with actionable paths. Consider list virtualization after measuring thousands of reminders.

**Proving tests:** 1k/10k notes, 25 MiB attachments, >25 MiB skipped files, thousands of reminders/projects, high RTT and weeks offline; record peak memory, request counts, CPU, time-to-first-usable-list and queue drainage. Stress cleanup above/below its service rate and verify backlogs shrink after load subsides.

Other observations:

- Metadata fast paths avoid rehashing every unchanged file, but periodic checks still discover visible/hidden files and probe manifest deletions. At 10k files, adapter I/O matters as much as hashing.
- Prepared binary limits are 48 MiB mobile / 128 MiB desktop, not total process memory. Base64, JSON, response buffers and UI state add overhead. Worker memory is shared per isolate, not per request; concurrent large buffered requests deserve measurement against Cloudflare's 128 MB limit. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- Reminder lists return the whole workspace and deserialize per-file caches. ETags avoid unchanged response bodies but still require enough metadata work to construct the revision. A 1 MiB project ceiling is a functional limit before the 25 MiB sync ceiling (F14).
- Sync history is capped at 20 entries and 50 paths per entry; conflict copies are ignored; changelog pruning and orphan sweeping exist. This avoids several obvious unbounded stores but limits investigation history (F18).
- Current size checks passed: plugin about **1,318 KiB raw / 729 KiB gzip**, Worker **1,183 / 544 KiB**, PWA startup set **385 / 128 KiB**, all PWA JS **407 / 135 KiB**. Treat these as measured build artifacts, not network/phone startup timings. The plugin embeds deployment artifacts, which explains part of its size. No blanket dependency purge is justified.

## 14. Open-source readiness

README, architecture, sync pipeline, Worker API, testing, deployment, privacy/security policy, 0BSD license and third-party notices give contributors a useful map. The release workflow verifies tag/version agreement, runs checks across supported Node versions, compares artifact hashes and creates provenance attestations. This is a strong starting point. The repository has no committed generated plugin bundle in the audited state.

Contributor-facing gaps include a focused contribution guide, issue templates for sync/data-loss reports, a versioned change/migration history, dependency update automation, and a completed rather than blank release record. A code of conduct is an optional community governance choice, not a correctness release gate. A new contributor can understand the main components, but will struggle to reproduce a multi-device corruption report without the F18 work.

### F18 — Recovery and diagnostics cannot yet explain a serious data-loss incident reliably

**Severity:** HIGH. **Confidence:** High. **Category:** Missing protection/test. **Area:** Observability, backup and disaster recovery.

**Problem / why it matters:** Request IDs, local activity history, change sequences, conflict metadata and maintenance counts exist, but they do not form a durable causal audit trail. A report arriving after 20 sync runs can have lost the relevant local history. A retained version is not an independently tested account-loss recovery plan.

**Failure sequence:** A user reports “Crate deleted one of my notes” days later. Local history has rotated; server change records identify path/action but not the originating operation/device/base, and request IDs are not carried through the client decision, commit, cleanup and acknowledgement. A missing R2 key can be detected but its deletion cause cannot be reconstructed. Restoring an older D1 snapshot after object GC may recreate references to objects that no longer exist.

**Files/symbols:** [Worker request IDs][worker-entry], [runtime history][history], [history limits][history-limits], [diagnostics][diagnostics], [maintenance diagnostics][maintenance-diagnostics], [retained-version restore][restore], [release checklist][release-checklist]. **Root cause:** Operational metadata describes local outcomes rather than the distributed intent/commit chain; no exercised paired data/metadata disaster-recovery procedure.

**Recommended change:** Add a bounded privacy-safe diagnostic export and durable operation trail: client/device pseudonym, sync session and operation IDs, protocol/app versions, cursor, path pseudonym, base/local/remote hashes, expected revision, action, commit outcome, object key and retry/ack/cleanup reason. Never include note bodies or credentials; make filenames opt-in/redacted. Expose oldest pending job, failed delivery count, GC backlog age and sampled dangling-reference checks. Document and rehearse coordinated D1/R2 backup/restore plus derived-index/DO schedule rebuild in a disposable account.

**Proving tests:** Reconstruct injected F01/F02/F13 incidents from exported diagnostics without private content. Restore a clean deployment from independent backup after original resources are unavailable; validate every referenced object's hash before allowing writes. Test restore when retention/GC advanced after the snapshot.

Minimum public-release support workflow: stop destructive repair attempts, preserve local originals/trash/conflict copies, collect a redacted diagnostic bundle, inspect versions, and restore a verified copy under a new path before resuming normal reconciliation. Do not recommend force full sync or deleting the local manifest as the first response to an unexplained loss report.

## 15. Recommended release plan

### Must fix before release

1. **Restore the core preservation guarantees:** F01, F02 and F03, with real binding/adapter regressions and no live dangling references under injected faults.
2. **Make reminder intent durable and replay-safe:** F04 and F05. Correct timezone round-trips and occurrence identity before promising reliable reminders.
3. **Close notification races:** F06/F07, or keep the affected scheduling feature unavailable until its committed-revision contract is implemented and verified.
4. **Prevent deployment downgrade and incompatible writes:** F11 and the mutation compatibility gate in F12. Test joining older devices against the release server.
5. **Preserve PWA drafts and truthful mutation state:** F08/F09. Do not treat a transient save failure as permission to discard entered data.
6. **Fix F13's stale delete/recreation behavior.** Revision/incarnation semantics belong in the first stable public protocol.
7. **Get a clean release candidate through F15 gates**, including browser tests, minimum Obsidian and physical mobile smoke checks. Record exact artifact hashes and run the independent-account OAuth path.

### Should fix before release

1. F10 cross-tab logout and session fencing; F14's accepted-write/unreadable-workspace mismatch.
2. F18 minimum diagnostic export, reference-integrity check, and a rehearsed independent recovery path.
3. F17 explicit credential folder scope, subscription caps/deadlines and abuse controls.
4. F19 dependency fixes, action pinning and proper history/CI secret scanning.
5. F16 visible skipped-file status, bounded notification reconciliation and resumable reminder warmup; benchmark at least 1k and 10k files.
6. Real legacy-schema migration/rollback fixtures, including Unicode portable paths, plus published compatibility and data-format changes.

### Can safely follow after release

1. UI list virtualization and incremental index optimizations justified by measurements.
2. Richer conflict comparison/merge UX and longer optional diagnostic retention.
3. A durable offline mutation queue, **after** idempotency/revision/session contracts are safe; cached read-only mode can be an honest initial scope.
4. Broader property/fuzz tests and more platform permutations beyond the required preservation/compatibility cases.
5. Contributor templates/community improvements and further module extraction only where actual ownership is unclear.

Public source publication is distinct from approving a release for real user vaults. If source is published earlier, describe the candidate as experimental and explicitly document the known blockers; that does not substitute for fixing them before a supported vault-sync release.

## 16. Highest-value improvements

If time permits only five engineering investments, prioritize these five coherent changes:

1. **One safe remote commit/cleanup lifecycle** for every mutation, including uncertain outcomes and reference-aware GC (F01).
2. **Revisioned, idempotent mutations** covering file incarnations, reminder editing bases and recurring occurrences (F02/F05/F13).
3. **Safe local application for every file type**, with atomic comparisons where available and durable preservation otherwise (F03).
4. **Canonical reminder time that survives every client**, preserving instants, date-only values and recurrence timezone through Markdown (F04).
5. **Notifications derived from committed reminder revisions**, with transactional outbox intent and token-fenced delivery progress (F06/F07).

These five prioritize preservation and reminder correctness. The PWA draft/state, deployment compatibility and failing release gates still need the work specified in section 15. If capacity is lower, reduce the released feature scope instead of leaving known preservation failures in enabled paths. A green lint/build or another round of cosmetic refactoring cannot compensate for the first three failures.

## 17. Release-readiness score

| Area | Score / 100 | Main factors |
|---|---:|---|
| Architecture | 78 | Clear boundaries and sensible primitives; duplicated commit lifecycle and competing notification authority. |
| Sync correctness | 62 | Strong common classification/CAS/merge foundation; file identity, real interleavings and compatibility gaps. |
| Data safety | 30 | Reproduced remote content deletion and stale overwrites; incomplete binary preservation. |
| Backend reliability | 50 | Real binding tests and recovery machinery; ambiguous commit and scheduling faults. |
| Obsidian plugin | 64 | Good lifecycle/event discipline; filesystem boundary and stale reminder writes remain unsafe. |
| PWA | 43 | Useful cached read-only mode and cache tests; draft loss, mutation races and rollout/session gaps. |
| Security | 70 | Explicit trust model, OAuth/credential/path controls; scope/abuse/supply-chain hardening still needed. |
| Testing | 56 | Broad existing suite; release failures and missing end-to-end failure semantics. |
| UI/UX | 62 | Intentional states and accessibility hooks; important data-state communication can be wrong. |
| Open-source readiness | 75 | Good documentation/license/release foundation; operational rehearsal and contributor tooling incomplete. |

The unweighted average is 61. I reduce the overall readiness judgment to **57/100** because data preservation and sync reliability carry more weight than polish or repository organization. This is an engineering assessment, not a statistical reliability estimate.

**Would I personally approve this repository for public release today? No.** The candidate has reproducible data-loss and silent-overwrite paths, and its release checks fail. I would reassess after the must-fix preservation, reminder/protocol and release-validation work is completed against the exact candidate artifacts.

[evidence]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2026-09-06/README.md
[upload]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/sync-file-handlers.ts:106
[batch-upload]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/sync-batch/upload.ts:183
[markdown-write]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/storage.ts:104
[pair-write]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/atomic-markdown-write.ts:154
[commit]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/sync-mutations.ts:39
[cleanup]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/sync-storage.ts:103
[restore]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/file-version-handlers.ts:37
[pwa-mutations]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/hooks/useReminderMutations.ts:66
[pwa-types]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/types.ts:70
[reminder-update]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/routes/update.ts:71
[plugin-update]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/data/markdown-writer/update.ts:46
[block-update]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/core/markdownReminderMutation.ts:97
[find-reminder]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/core/markdownReminderFile.ts:63
[local-apply]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/local-apply.ts:33
[binary-write]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/local-apply.ts:179
[preserve-local]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/local-apply.ts:55
[checkbox]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/utils/checkboxParser.ts:85
[recurrence-text]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/utils/rruleConverter.ts:92
[recurrence-calculator]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/utils/recurrenceCalculator.ts
[reminder-notifications]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/notifications.ts:14
[notification-service]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/services/notificationService.ts:143
[reminder-requests]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/requests.ts
[reminder-create]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/routes/create.ts:24
[reminder-complete]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/routes/complete.ts:12
[completion-plan]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/core/markdownReminderMutation.ts:176
[alarm]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notifications/reminder-alarm.ts:140
[reminder-runtime]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/runtime.ts:34
[plugin-lifecycle]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/plugin/lifecycle.ts:102
[outbox]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-outbox.ts:28
[pwa-sync]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/hooks/useReminderSync.ts:31
[session]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/hooks/usePwaSessionLifecycle.ts:13
[pwa-cache]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/reminder-cache.ts:35
[deployment]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/deployment-service.ts:160
[provisioner]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/provisioner.ts:179
[deployment-update]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/deployment-update.ts:24
[protocol]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/protocol.ts
[connection]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/worker-api/sync.ts:47
[engine-lifecycle]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/engine-lifecycle.ts
[service-worker]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/pwa/service-worker.ts:24
[pwa-update]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/hooks/usePwaUpdate.ts:5
[migration]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/migrations/0002_launch_hardening.sql:1
[delete]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/sync-file-handlers.ts:166
[delete-commit]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/sync-mutations.ts:94
[sync-types]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/protocol/sync-types.ts
[reminder-list]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/routes/list.ts:14
[cache-limits]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/reminder-cache/types.ts:6
[server-cache-persist]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/reminder-cache/persist.ts:21
[layout-tests]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/ui/remindersLayoutStyles.test.ts
[pwa-tests]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/pwa.test.ts
[package]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/package.json
[focus-test]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/scripts/pwa-focus-test.mjs:14
[ui-test]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/scripts/pwa-ui-performance-test.mjs:123
[release-workflow]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/.github/workflows/release.yml
[sync-runtime]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/runtime.ts
[engine]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/engine.ts
[manifest]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/manifest.ts:87
[reconciliation]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/reconciliation.ts
[markdown-merge]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/markdown-merge.ts
[queue]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/queue.ts
[conflict]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/conflict.ts:47
[main]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/main.ts
[router]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/router.ts:13
[notification-handlers]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-subscription-handlers.ts
[web-push]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notifications/web-push.ts
[gitignore]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/.gitignore
[state-machine]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/reconciliation-state-machine.test.ts:93
[transfer-budget]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/transfer-budget.ts
[sync-limits]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/protocol/sync-limits.ts
[file-discovery]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/file-discovery.ts
[transfer-prepare]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/transfer-prepare.ts
[reminder-api]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/reminder-api.ts:21
[orphan-sweep]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/maintenance/orphan-sweep.ts:26
[worker-entry]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/index.ts:10
[history]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/runtime-history.ts
[history-limits]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/plugin/settings-types.ts:54
[diagnostics]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/diagnostics.ts
[maintenance-diagnostics]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/maintenance/diagnostics.ts:9
[release-checklist]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/release-checklist.md
