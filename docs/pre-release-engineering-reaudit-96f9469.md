# Crate pre-release engineering re-audit

Audited 6 September 2026. Candidate: **`96f9469234481c8bc2798b393929f287b6b04cbc`**, `fix: harden sync integrity and prerelease safety`, on local `master`. Package/manifest version: `0.1.0`; protocol: `3`; minimum Obsidian: `1.13.0`; mobile enabled. The requested remediation commit was created before this analysis. It was not pushed. Production source remained unchanged during the re-audit.

This repeats the original end-to-end assessment of the plugin, sync protocol, local persistence, shared reminders domain, Worker/D1/R2, notification Durable Objects, PWA, deployment, recovery, and release process. It supersedes the earlier remediation note's implication that the broader safety guarantees were all closed. The original fixes materially improve the candidate, but their tests did not cover every composition and failure boundary.

## 1. Executive summary

**Recommendation: do not release this candidate for real vaults yet. Readiness: 76/100.**

The largest original defects have been addressed: uncertain D1 outcomes no longer trigger immediate object destruction; stale reminder writes have semantic revision checks; supported local text writes use atomic callbacks; unsafe binary replacement preserves incoming bytes for review; file deletes carry incarnation revisions; and reminder receipts make exact committed requests replayable. UTC/recurrence serialization, protocol enforcement, explicit deployment updates, browser draft retention, resource limits, and release checks are substantially stronger.

The remaining highest-risk defect is another local filesystem boundary: deletion hashes the file and later calls the host's trash primitive without preserving an edit made in between. With Obsidian's permanent-delete preference, the new edit can disappear without a recoverable Crate copy. Remote retention cannot recover bytes that never reached the server.

Four high-priority issues remain around sessions and notifications: online logout cancels its own revocation before dispatch; a completed projection can leave an obsolete alarm deliverable until the outbox catches up; replaying an accepted schedule can notify twice; and migrated subscriptions without owners remain eligible despite the new session/folder boundaries. Three medium-priority findings concern edited retry drafts, invisible terminal delivery failures, and restore retry/resume behavior.

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| R01 | BLOCKER | Remote deletion can erase an intervening, never-uploaded local edit. | Controlled host-delete interleaving. |
| R02 | HIGH | PWA logout invalidates the session before its revoke request is dispatched. | Real API/helper composition; Chromium and WebKit request capture. |
| R03 | HIGH | Old notifications can deliver after the current source projection has completed. | Real local D1/R2 plus actual alarm class, completion and title-change cases. |
| R04 | HIGH | Replayed outbox commands reset delivery identity and can notify twice. | Accepted schedule, completed delivery, same-job replay, second delivery. |
| R05 | MEDIUM | Editing an ambiguous failed save reuses an operation ID with a different request. | Real mutation hook plus real D1 receipt comparison. |
| R06 | HIGH | Legacy unowned push subscriptions bypass the new recipient boundary. | Actual D1 selection, session rejection, and maintenance pruning. |
| R07 | MEDIUM | Exhausted push delivery disappears from actionable diagnostics. | Alarm retry exhaustion plus actual diagnostics response. |
| R08 | MEDIUM | Recovery aborts on rate limits and cannot resume partially populated targets. | Controlled HTTP 429 and upload-acknowledgement loss. |

### Evidence and limits

[Reproduction sources, commands, logs, and artifact hashes][evidence] are preserved separately from the normal tests. Their assertions intentionally establish bad behavior. **Eleven focused tests and two browser runs reproduced the eight findings.** Alarm reproductions use real local D1/R2 and the production alarm class with controlled DO storage and a mocked sender; they do not establish physical push timing. The local delete test models a documented host setting, not a physical Obsidian run. The recovery tests do not contact a hosted account.

| Fresh check after the commit | Result |
|---|---|
| `npm run release:check`, Node 24.19.0 | Passed in full. |
| Unit suite | 1,013 passed in 177 files. |
| Existing local Cloudflare runtime suite | 42 passed in six files. |
| Recovery archive suite | Five passed. |
| Lint, plugin/Worker types, dead code, notices | Passed. |
| PWA preview, production build, CSS scope, size budgets, release artifacts | Passed. |
| Cache/focus/performance/safety browser suites | Passed Chromium and WebKit. |
| Visual suite | All 48 passed against committed baselines. |
| `npm audit` | Zero reported vulnerabilities, including development dependencies. |
| Gitleaks 8.30.1 | No findings in 434 locally available commits or current source. |

The baseline release check ran before adding the temporary audit fixtures. Lint and visual types were checked after removing them. Clean installation and byte-identical builds on Node 20/22/24 were established during remediation; they were not repeated in this audit. Hosted CI on this exact commit, physical Obsidian desktop/iOS/Android, independent-account OAuth/deployment, real push, hosted paired restore, and the community-directory scanner remain unverified. No claim of production load capacity or exhaustive secret absence follows from these local checks.

### Disposition of the original findings

“Fixed” below means the original reproduced scenario has a targeted implementation and passing regression coverage; it is not a blanket certification of its subsystem.

| Original finding | Current disposition |
|---|---|
| F01 uncertain-commit content deletion | Fixed in the reviewed single, batch, Markdown and paired write paths. |
| F02 stale reminder overwrite | Fixed through semantic base revisions and fresh local block comparison. |
| F03 unsafe local replacement | Fixed for the reproduced replacement paths; related deletion invariant remains open as R01. |
| F04 timezone/recurrence serialization | Fixed in the shared serialization paths with expanded round-trip tests. |
| F05 reminder retry idempotence | Exact committed replay fixed; editing an ambiguous attempt exposes R05. |
| F06 alarm interleaving | Newer schedule state is fenced against old in-flight writes; accepted-command replay remains R04. |
| F07 notification authority | Committed-source projection is implemented; projection-to-outbox handoff remains R03. |
| F08 optimistic PWA state | Acknowledgements merge into current state and operations are fenced. |
| F09 failed-save draft loss | Drafts survive failed saves/reload; edited retry recovery remains R05. |
| F10 logout | Cross-tab/local fencing improved, but its composition prevents remote revocation: R02. |
| F11 automatic deployment downgrade | Joining no longer uploads code; explicit updates compare authoritative versions. |
| F12 compatibility/migrations | Protocol 3 gates and retryable path migration implemented; hosted rollout still needs rehearsal. |
| F13 same-content delete/recreate | Fixed by opaque revision preconditions on deletes. |
| F14 oversized reminder indexing | Healthy remainder and persistent per-file size issues implemented. |
| F15 failing release gates | Fresh full release and visual checks pass. |
| F16 resource limits | Individual work and upload/query budgets bounded; large-vault capacity still unmeasured. |
| F17 authorization/abuse | New sessions, routes, ownership, providers and rates hardened; legacy recipients remain R06. |
| F18 operations/recovery | Paired archive and queue diagnostics added; terminal delivery and resume gaps remain R07/R08. |
| F19 supply chain | Dependency audit clean; pinned actions/scanner and separated publication permissions implemented. |

## 2. Release blockers

### R01 — A remote deletion can erase an edit made after the local hash check

**Severity:** BLOCKER. **Confidence:** High. **Category:** Confirmed bug in the local deletion protocol; physical host interleaving not tested. **Area:** Sync application to the vault.

**Problem and impact:** [deletePathLocallyIfUnchanged][local-delete] reads and hashes current bytes, then separately calls `deletePathLocally`. For visible files that invokes `fileManager.trashFile`; it neither enforces the checked hash at deletion nor preserves the bytes actually removed. [Transfer processing][delete-transfer] treats the outcome as successfully deleted and removes the manifest entry. The replacement hardening does not cover this path.

**Failure sequence:** (1) Device A deletes an acknowledged file and the remote deletion reaches B. (2) B's delete plan expects hash H. (3) B reads H successfully. (4) A local editor or plugin writes new bytes H2 before the host performs the deletion. (5) Crate deletes H2 and reports `deleted`. (6) H2 has never been uploaded, so neither immutable R2 history nor an old merge base contains it. The injected host-boundary test records H2 being removed and no surviving local file.

Obsidian allows a permanent-delete preference as well as trash destinations; its documentation states permanent deletion cannot be recovered through trash. This makes the unchecked interval a credible loss scenario, even though a configured trash destination can often recover it. [Obsidian file deletion settings](https://obsidian.md/help/settings)

**Root cause:** A preflight observation is used as a destructive-operation precondition. Hash checking and deletion are separate asynchronous operations, and there is no Crate-owned recovery record tying the removed bytes to the decision.

**Recommended change:** Define a recoverable local deletion protocol: preserve or quarantine the exact object removed using host-supported atomic operations, validate it against the expected version, and recover a concurrent edit instead of acknowledging deletion. Serialize with supported host operations where possible; when the required guarantee is unavailable, defer the destructive step. Merely adding another asynchronous hash check leaves the same race.

**Tests proving a fix:** Write at every boundary between discovery, read, hash, trash/rename, and manifest acknowledgement. Cover text and binary files, visible and hidden paths, every deletion preference, delete/recreate, failure while preserving bytes, and restart after quarantine but before acknowledgement. Assert that every intervening edit remains either at the source or in an identifiable durable recovery copy. Run the decisive cases in real Obsidian.

R02, R03, R04 and R06 are also release gates for the advertised session and notification behavior, although their severity is HIGH rather than BLOCKER. A green existing suite does not waive them.

## 3. Critical/high-priority findings

### R02 — Online PWA logout cancels its own session revocation

**Severity:** HIGH. **Confidence:** Confirmed. **Category:** Confirmed bug. **Area:** PWA/API/session lifecycle.

**Problem and impact:** [performPwaLogout][logout] starts `apiFetch('/auth/session', {method: 'DELETE'})`, immediately clears the local session, then waits for cleanup. The [real API wrapper][pwa-api] awaits compatibility negotiation before dispatching mutations and then rechecks session generation. Local clearing invalidates that generation first. The revoke request therefore throws before `fetch('/auth/session')` runs. The exception allowing a logout response after invalidation is too late: it is below the network call.

**Failure sequence:** (1) A valid browser session invokes Log out. (2) Compatibility checking yields. (3) Local storage, drafts, and cache are cleared and the generation changes. (4) The API wrapper resumes, rejects the changed generation, and never sends DELETE. (5) The server token and its owned subscription records remain unless another cleanup path removes them. The token can remain valid for its remaining 90-day lifetime. A previously obtained copy remains usable.

The unit reproduction composes the actual API wrapper and logout helper and receives cleanup failure without a revocation call. Both Chromium and WebKit reproduce zero revoke requests with the bundled PWA. Local and cross-tab clearing still work. The helper selects a local-only logout warning on failure, but the browser flow unmounts the authenticated shell; warning visibility is not established by this test.

**Root cause:** Ordinary request cancellation and mandatory session revocation share a generation guard with incompatible lifetimes. Tests mocked the API boundary, so successful direct server revocation and successful local clearing were mistaken for a working composed logout.

**Recommended change:** Give logout a narrowly scoped, immutable credential-bound revocation operation that survives local invalidation. Keep immediate local clearing, prevent unrelated old-session writes/cache updates, and expose remote revocation failure with an actionable path. Do not disable session guards globally.

**Tests proving a fix:** Use the real wrapper and server handler in one test. After online logout, prove the old token returns 401 and owned subscriptions are removed; assert the actual DELETE was dispatched. Cover cold/cached compatibility, slow negotiation, revoked credentials, network failure, multiple tabs, and unrelated in-flight requests that must remain fenced.

### R03 — The projection/outbox handoff allows obsolete reminders to notify

**Severity:** HIGH. **Confidence:** Confirmed under controlled scheduling. **Category:** Confirmed bug. **Area:** Committed Markdown → projection → notification outbox → alarm delivery.

**Problem and impact:** [Projection][projection] updates `reminder_projections.file_revision`, replaces notification jobs, and removes the source projection job in one D1 transaction. [Alarm delivery][alarm-deliver] checks whether the projection matches the current file and whether a source projection is pending. It does not associate the scheduled payload with that projection revision or fence on the pending notification outbox command. Once projection finishes, the old scheduled row can look current while its cancellation or replacement is still pending.

**Failure sequence:** (1) Reminder “Old title” has a scheduled alarm. (2) A client commits completion or “New title.” (3) Projection processes the new bytes, updates the file revision, and queues cancel/reschedule. (4) Before that outbox command reaches the reminder DO, the old alarm fires. (5) Its checks see a current projection and no pending source job; it sends “Old title.” (6) Cleanup removes the old scheduled row. Both completion and title-change variants reproduced using actual storage and alarm code.

**Root cause:** “The source has been projected” is mistaken for “this specific alarm represents the projected source.” File, projection, outbox, and delivery each have tokens, but the scheduled payload lacks a durable causal link across this handoff.

**Recommended change:** Carry a source/policy/occurrence revision through the outbox and scheduled state, validate the current notification intent before beginning delivery, and fence while a newer schedule/cancel command is pending. Preserve this linkage even after the outbox row is removed. A provider send already in flight cannot always be recalled; this reproduction concerns a preventable send that starts after the new intent is committed and projected.

**Tests proving a fix:** Fire the alarm before projection, after projection/before outbox, during outbox application, and after its acknowledgement for completion, deletion, title/due changes, project moves, recurrence advancement and policy changes. No obsolete occurrence may begin delivery. Include restart at every handoff and outbox backlogs spanning several coordinator alarms.

### R04 — Replaying an accepted notification job can deliver the same occurrence again

**Severity:** HIGH. **Confidence:** Confirmed under controlled scheduling. **Category:** Confirmed bug. **Area:** Outbox retry idempotence and Durable Object delivery state.

**Problem and impact:** [Alarm PUT handling][alarm-fetch] checks that the job token is currently authoritative, but every accepted PUT creates a new random schedule token and clears delivery/retry state. Successful delivery later clears all DO state. Replaying the same still-pending outbox job after an acknowledgement failure therefore creates another deliverable occurrence.

**Failure sequence:** (1) Outbox job J schedules a reminder successfully. (2) Its acknowledgement or the D1 removal acknowledgement is lost, leaving J pending. (3) The due event delivers successfully and clears its scheduled row/state. (4) The coordinator retries J. (5) PUT accepts the same job, creates a new schedule identity, and rearms it. (6) A second alarm sends the same reminder. The reproduction observes two sender calls for the same accepted command.

**Root cause:** A random per-application fence is also serving as the occurrence identity. It protects newer state from old writes but cannot deduplicate reapplication of the same intent after completed delivery.

**Recommended change:** Persist accepted/completed job or occurrence receipts independently of transient alarm state. Reapplying the same command must acknowledge the existing outcome without resetting delivery progress. New genuine occurrences still need distinct identities. Define the retention horizon relative to outbox retries and upgrades.

**Tests proving a fix:** Lose the DO response and the outbox deletion response separately; retry before, during and after delivery and after DO restart. Include partial per-subscription success and a newer occurrence overtaking the retry. Assert at most one logical delivery attempt sequence per occurrence/recipient, while documenting the unavoidable ambiguity of a push provider accepting a send whose response is lost.

R06, the remaining high-priority subscription authority issue, is detailed in section 10. R05, R07 and R08 are medium-priority findings in their respective client, backend and recovery sections.

## 4. Sync correctness assessment

### End-to-end lifecycle

The vault is the local source. `SyncRuntime` records events and queues paths with local queue revisions; `SyncEngine` serializes workflows and delegates discovery, planning and transfer. `LocalManifest` retains acknowledged hashes, opaque remote revisions, metadata and the changelog cursor. Volatile event queues are rebuilt from surviving file state after restart; they are not a durable operation journal.

Uploads stage immutable R2 objects. Conditional D1 statements publish the logical path, content hash, storage key, changelog, retained version, and Markdown projection intent together. An ambiguous D1 result retains staged bytes. Reference-aware cleanup consults live and retained metadata; orphan deletion uses an uncertainty window. Same-content acknowledgement verifies the currently referenced object. These changes close the original destructive cleanup/retry scenario.

Initial reconciliation compares a paginated remote manifest with local state and catches up through the changelog. Incremental synchronization uses the server sequence rather than device time. An expired cursor triggers full reconciliation. Current local, acknowledged base and current remote state feed the shared planner. A hash-verified Markdown base permits deterministic merge; overlapping edits preserve a local conflict copy. Conflicts and incoming binary copies are intentionally local review artifacts, so another device does not automatically receive those copies.

Local text replacement uses supported atomic processing. Existing binaries without an atomic host replacement guarantee retain the original and preserve incoming bytes for review. This is safer but requires explicit resolution. Deletes carry the acknowledged remote incarnation to reject stale server deletes, yet their local application still has R01. A force-full workflow is explicitly local-authoritative and suppresses remote deletion when preceding upload work fails; it should not be used to diagnose unexplained missing files.

### Realistic multi-device outcomes

| Scenario | Current behavior and remaining qualification |
|---|---|
| A and B edit the same note offline | File CAS rejects a stale write; a known base permits disjoint Markdown merge. Overlap preserves a conflict copy. Real whole-client convergence under random scheduling is not yet established. |
| A edits while B deletes, either arrival order | The declared edit-wins policy preserves the edit by re-uploading/restoring. It can intentionally resurrect the old path. R01 applies when an edit lands after the final local delete check. |
| A renames while B edits | Rename is delete plus create; the edit can survive at the old path while A's snapshot lives at the new path. There is no stable file identity that moves B's edit automatically. |
| A and B rename differently | Both destinations can survive. This duplicates logical content rather than proving either rename was lost. |
| Delete then recreate with identical bytes | The recreated file has a new opaque revision; a delete carrying the old revision is rejected. This is now covered with real bindings. |
| Three devices mutate related files | Per-file checks and bounded replanning apply; generic multi-file state has no all-vault transaction. Preserve all versions or surface conflict, then retry until quiescent. End-to-end randomized coverage remains missing. |
| PWA form remains open while Obsidian edits | Semantic revision checks reject the stale target instead of silently replaying old fields. The draft remains available; recovery from an ambiguous edited retry is R05. |
| Server commits but response is lost | File storage remains intact and exact web requests replay committed receipts. Editing the request before reconciliation is R05; the notification outbox has R04. |
| Client crashes halfway through apply | Manifest generations and durable vault bytes allow later re-reconciliation, but there is no vault-wide atomic commit. Host process-kill tests remain necessary, especially for delete quarantine and project moves. |
| Device is offline beyond changelog retention | Full comparison replaces sequence replay. Missing merge bases reduce automatic merge ability; old retained versions are not an indefinite backup. |
| Backend read finds a missing/corrupt object | It reports an integrity/unavailability failure rather than accepting empty content. Recovery needs known-good bytes; detection does not reconstruct them. |

### Safety invariants

| Invariant | Assessment |
|---|---|
| Every live/retained remote reference resolves to verified bytes | Stronger and exercised under lost D1 responses. External corruption/account loss still requires backup. |
| A stale server delete cannot erase a new same-content incarnation | Enforced by expected hash plus revision. |
| Every newer local edit survives remote application | Replacement improved; **violated by local deletion R01**. |
| A stale editor cannot overwrite a changed reminder | Semantic revision plus file CAS enforce rejection; disjoint field edits may still require manual conflict handling. |
| Replaying accepted intent has no additional effect | True for exact committed web mutations; **not true for accepted notification scheduling R04**. |
| Notification payload matches current committed intent | **Violated at projection/outbox handoff R03**. |
| Acknowledgement cannot skip unapplied changes | Focused workflow/queue/manifest tests pass; full process-crash proof remains incomplete. |
| Timed and calendar semantics survive serialization | UTC instant and recurrence metadata fixes are covered; physical locale/input behavior remains a release check. |

## 5. Sync threat model

Trusted authorities are the vault process and its plugins, vault-authorized clients, the Worker deployment, and the owner's Cloudflare account. Browser reminder sessions have narrower authority. Network requests may be duplicated, reordered or lose acknowledgements; devices may be offline, stale, skewed or interrupted. A compromised vault credential can intentionally modify vault files. Cloudflare can access their contents; this is not an end-to-end encrypted sync design.

| Threat | Protection today | Residual exposure |
|---|---|---|
| Latest content is lost | Immutable staging, uncertain-outcome preservation, retained versions and hash verification. | R01 can remove bytes that never left the local vault. Same-account history is not disaster backup. |
| Newer content is overwritten | Server CAS, reminder semantic revisions, atomic text apply, preserved binary incoming copies. | Host deletion boundary remains unsafe; a user accepting a conflict can still choose an older version. |
| Content becomes corrupted | Hash/size checks, verified bases, archive verification, fail-closed reads. | A missing/corrupt R2 object requires a known-good copy; integrity failure can impair reminder-index availability. |
| Data is duplicated | Stable reminder identities and committed request receipts. | Concurrent renames can leave both paths; local project moves can be interrupted; R04 duplicates notifications. |
| Deleted data reappears | Explicit edit-wins handling preserves competing edits; incarnation-aware deletes. | Resurrection is sometimes intended. UI must distinguish it from an unexplained delete failure. |
| Devices diverge | Shared reconciliation, cursor fallback and repeatable per-file processing. | Conflicts are local-only, binary review can remain pending, process interruption/rename outcomes need end-to-end testing. |
| PWA differs from Obsidian | Shared parser/serializer, semantic revisions, cache generations, committed-source projection. | R03 stale push, R05 stuck edited retry, cached read-only snapshots while offline. |
| Logout leaves private access active | Local clearing and cross-tab/in-flight fencing; server revoke handler exists. | R02 never dispatches that handler; R06 legacy subscriptions retain delivery eligibility. |
| Data becomes unrecoverable | Local copies, 30-day remote version retention, paired D1/R2 archives. | Never-uploaded R01 edits, compromised account, expired history; R08 prevents straightforward resume after interrupted recovery. |
| Old clients damage newer state | Protocol 3 mutation gate and explicit deployment update path. | Mixed-version rollout/draining and hosted interrupted migrations have not been rehearsed. |

The next fault-injection suite should track byte ownership as an invariant across every failure boundary, not merely compare endpoint status codes. At least one durable copy of each accepted local edit must remain until its explicit conflict resolution or safe deletion.

## 6. Architecture assessment

The component boundaries are appropriate for this product. The plugin entry point remains small; lifecycle, sync orchestration, transfer, planning, reminders storage, deployment and UI are delegated. Shared reminder parsing, revision calculation, recurrence serialization and presentation reduce semantic drift between Obsidian and the PWA. The Worker is bundled with the plugin and hash-verified before deployment; joining an existing deployment does not silently replace it.

The D1/R2 split is also appropriate: immutable byte objects plus transactional metadata avoid overwriting live objects in place. The most valuable new abstraction is the shared commit-effects path, which attaches receipt and projection intent to the file transaction. A shared explicit notification policy correctly prevents another device's startup settings from becoming an accidental authority.

The weak boundaries now concern durable identity and lifecycle rather than file organization. File incarnation, reminder semantic revision, web operation receipt, projection job, notification job and schedule token each solve a different problem. Tests need to exercise their joins. R03/R04 show why a token valid in one layer does not prove that the next layer's side effect is current or already complete. Likewise, a locally invalidated browser generation is not a remotely revoked credential.

Practical structural changes should therefore be limited to three areas: one recoverable local apply/delete protocol, one versioned notification-intent lifecycle, and one explicit browser mutation/session cleanup contract. These reduce correctness duplication and make fault injection possible. A generic repository framework, wholesale state-management rewrite, or moving code purely to meet a line-count target would contribute less.

Two architectural risks deserve follow-up without being represented as newly reproduced release blockers:

- **Local cross-project move interruption — MEDIUM, confidence High, architectural risk.** The [local reminder writer][local-move] writes the destination before removing the source and rolls back caught failures. A process exit between writes cannot execute that rollback and can leave duplicate stable IDs. This matters because global projection identity is keyed by reminder ID. The root cause is a two-file operation without a restart journal. Add a durable move intent or explicit duplicate repair; prove restart after each write preserves content and yields one declared identity/location. No physical crash reproduction was performed.
- **Mixed-version path migration — MEDIUM, confidence Medium, missing protection/test.** Ordered migration and a readiness marker fence cooperating new clients, but previously running Worker invocations and older deployed code need an explicit rollout assumption. A legacy write arriving during normalization could escape a gate that only new code reads. The [provisioning code][provisioner] needs a documented drain/maintenance procedure or a database-level invariant that old writers cannot bypass. Prove the procedure with a real legacy schema and deliberately delayed old-code writes. This is an unverified rollout risk, not a confirmed observed collision.

The Worker/D1 deployment remains a single shared availability and authorization boundary. That is reasonable for a personal vault, provided the user can export and restore independently. It would need different tenancy and isolation work before serving unrelated owners from one deployment.

## 7. Cloudflare/backend assessment

Workers, D1, R2 and alarm Durable Objects fit the workloads. Short request handlers, bounded projection/outbox work and server-owned scheduling are preferable to relying on a mobile plugin to stay alive. D1 transactions provide the metadata boundary; neither R2 nor the external push provider participates in that transaction. The corrected storage lifecycle now respects this distinction.

| Failure boundary | Current behavior / assessment |
|---|---|
| R2 upload fails before metadata commit | No new live metadata should publish; preserved local source can retry. |
| D1 fails before or after an ambiguous commit | Staged bytes are retained, current bytes are verified on retry, delayed cleanup checks references. Original regression cases pass. |
| Staging succeeds but no commit ever occurs | Age-delayed orphan cleanup can reclaim unreferenced bytes. Storage overhead is a deliberate safety tradeoff. |
| Projection or outbox is unavailable | Durable pending work and coordinator/maintenance wakeups provide retries. R03 permits an old schedule during one handoff. |
| Alarm PUT succeeds but acknowledgement is lost | The same command can be retried; R04 currently resets identity and allows another delivery. |
| Push recipient returns a permanent error | Subscription is pruned or quarantined according to provider status. Recipient authority still needs R06. |
| Push has transient failures | Delivery retains failed recipients, uses bounded backoff and a network deadline; R07 hides terminal exhaustion. |
| Maintenance stops | Token pruning, orphan/retention cleanup and recovery wakeups lag. Counts and last-run/error help, but age-based alerting is incomplete. |
| Deployment/account is lost | Local copies and an independently stored paired archive are required. Hosted restoration has not been demonstrated. |

D1 query limits apply to individual statements in batches as well as invocation budgets. The bounded upload/delete design and parameter limits are meaningful improvements. Cloudflare currently documents 50 queries per Free invocation, 100 bound parameters per query, and a 2 MB row/string limit; those constraints should remain explicit in tests as commit effects evolve. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

### R07 — Exhausted delivery has no actionable status in diagnostics

**Severity:** MEDIUM. **Confidence:** Confirmed under controlled retry state. **Category:** Confirmed observability bug. **Area:** Alarm failure lifecycle and support diagnostics.

**Problem and impact:** [scheduleRetry][alarm-retry] stops after its attempt/age budget, stores `deliveryFailure` inside the DO and deletes the alarm. The scheduled D1 row remains. [handleDiagnostics][diagnostics] counts failed projections and outbox jobs, but cannot see this DO-local terminal failure. A reminder may look scheduled while no further delivery is pending.

**Failure sequence:** (1) The outbox successfully schedules and acknowledges a reminder. (2) Push repeatedly fails. (3) Retry exhaustion records the failure only in DO storage and removes its alarm. (4) Diagnostics returns `status: 'ok'`, one scheduled reminder, zero pending/failed projection jobs and zero pending/failed notification jobs. This response was reproduced alongside the terminal DO state. The issue is missing actionable delivery health; HTTP success alone is not treated as a promise that all subsystems are healthy.

**Root cause:** Diagnostic ownership stops at the outbox, but the delivery lifecycle continues beyond it. A terminal state with no further automatic work is stored where the standard support endpoint does not inspect it.

**Recommended change:** Persist a bounded D1 delivery outcome tied to occurrence/recipient identity, including terminal reason, last attempt and age. Expose failed and overdue delivery counts plus a safe retry/re-enrollment action. Avoid scanning every DO during a diagnostics request. This can share the durable occurrence record required by R04.

**Tests proving a fix:** Exhaust both attempt and age limits, restart the DO, and inspect the real endpoint/UI. Assert the terminal state remains visible, retries do not silently restart completed recipients, and successful repair clears the correct failure without hiding newer failures.

## 8. Obsidian plugin assessment

Lifecycle ownership is generally sound. The entry shell delegates initialization; event/DOM/interval work is registered or explicitly disposed, and sync runtime replacement destroys the previous engine. Secrets are scoped to the Worker rather than synced as ordinary settings. The minimum app version acknowledges use of current Obsidian APIs. These are good source-level properties; repeated host enable/disable and mobile suspension remain untested here.

The reminder writer now checks the current block inside atomic local processing, reducing stale index/editor hazards. Stable IDs, captured semantic revisions and the shared serializer preserve title, description, priority, exact due instant and recurrence progress through ordinary edits. Cross-project moves still require the restart protection described in section 6.

The main plugin risk is R01. “Respect host trash preferences” is sensible UI behavior, but it does not itself satisfy sync's content-preservation requirement. Tests must model the actual supported trash modes and vault adapters. Existing binary conflict preservation also changes normal UX: a remote binary update can leave an incoming copy pending review instead of immediately replacing the original. The UI must make that state and its resolution discoverable, especially after restart.

Other practical verification priorities are mobile filesystem case/Unicode behavior, hidden paths, metadata/event ordering, concurrent file creation, and persistence under disk/quota errors. Metadata shortcuts rely on host file statistics; an external writer preserving both timestamp and size can evade cheap change detection until a stronger reconciliation path reads bytes. Treat this as a verification gap, not evidence that all ordinary edits are missed.

Do not mark the candidate mobile-ready solely because browser code avoids Node APIs and the manifest says `isDesktopOnly: false`. A physical iOS/Android pass needs real vault files, background/resume, low storage, conflict resolution, and unload during an active request. The [release checklist][release-checklist] already identifies much of this work.

## 9. PWA assessment

The PWA has a coherent cached read-only mode, versioned IndexedDB snapshots, session-generation fencing and explicit server compatibility checks. Successful mutation results merge into current state rather than overwriting a stale whole-list snapshot. Multiple tabs clear private local state on logout. The full cache, focus, typing/undo/composition, pull-layout and safety suites now pass in Chromium and WebKit.

The two remaining concrete client defects are R02 and R05. They arise when independently correct behaviors are composed: immediate local clearing versus delayed revocation, and durable draft retention versus immutable operation receipts. Tests should use the real API layer for these lifecycle transitions.

Service-worker updates retain caches needed by active clients and avoid blindly destroying older lazy assets. A tab surviving several deployments, a pending editor during update, and iOS installed-web-app suspension still need hosted tests. Browser-engine tests do not exercise OS push permission persistence or service-worker eviction. Browser local storage holds a bearer credential and IndexedDB holds private reminder content as disclosed; same-origin code and device/browser access remain trust boundaries.

### R05 — Editing an ambiguous save traps the draft behind a reused operation ID

**Severity:** MEDIUM. **Confidence:** Confirmed. **Category:** Confirmed client/server recovery bug. **Area:** Reminder editor draft persistence and mutation receipts.

**Problem and impact:** [saveReminder][pwa-mutations] builds a new body from the editable draft on each attempt while retaining `currentModal.operationId`. [Draft restoration][drafts] restores that ID through reload. The [receipt layer][operations] correctly rejects an ID reused with different request content. Once the first body committed, an edited retry cannot succeed under the old ID; reloading restores the same conflict.

**Failure sequence:** (1) The user saves “Original” with operation O. (2) The server commits O but the response is lost, so the modal remains open. (3) The user changes the draft to “Edited after ambiguous save.” (4) Retry sends the new body with O. (5) The server returns 409 because its receipt hash differs. (6) Repeated retry, including restoring the persisted modal, repeats that mismatch. The real hook reproduction confirms the changed body/same ID, and real D1 receipt checks confirm exact replay succeeds while the edited request repeatedly conflicts.

**Root cause:** The mutable editor state and the immutable attempted command share one stored operation identity. The client retains the draft but has no explicit “outcome unknown; reconcile the earlier attempt first” state.

**Recommended change:** Persist the exact attempted command separately from subsequent edits. Reconcile or replay the original attempt to obtain its committed result; then submit retained new edits as a new operation against the acknowledged reminder revision. Blindly generating a new create ID after a timeout can introduce duplicates and is not a sufficient fix. Replace the current reload advice with an actual recovery action.

**Tests proving a fix:** Use a real handler that commits and drops its response, edit title/project/recurrence before retry, reload the browser, and retry again. Prove there is one created reminder, one advance per recurring occurrence, preserved newer draft content, and a clear path to saving it. Include a concurrent third-party edit and a source moved or deleted before reconciliation.

## 10. Security assessment

The owner-hosted trust model is disclosed: no hidden telemetry, optional push, browser offline storage, and no Crate end-to-end encryption. Authentication hashes bearer tokens, rejects unavailable/expired credentials, and limits reminder sessions to an enrolled folder. New web sessions cannot administer the vault or renew themselves. Push endpoints are restricted to recognized providers, redirects rejected, calls deadline-bounded, and ownership, caps and request rates enforced in D1. These are substantial improvements over the original candidate.

R02 breaks the expected online logout security transition. The server handler is not the problem; the real client never invokes it. Documentation saying logout revokes the session's subscriptions overstates current behavior and should be verified with the exact installed client after the fix.

### R06 — Legacy unowned subscriptions remain authorized for push indefinitely

**Severity:** HIGH. **Confidence:** Confirmed for recipient selection and cleanup. **Category:** Confirmed authorization migration bug. **Area:** Subscription migration, recipient selection and token expiry.

**Problem and impact:** [Migration 0007][scope-migration] adds nullable owner and folder columns without quarantining existing subscriptions. Both [recipient selection and sending][push-recipients] accept rows with `folder_path IS NULL`, even when `owner_token_id` is also null. New authorization rejects legacy unbound reminder sessions, but the associated old push row remains eligible for whatever folder the notification policy now selects. Browser-token expiry is also not checked at send selection; it relies on later maintenance deletion.

**Failure sequence:** (1) A pre-upgrade browser enrolled a subscription with no recorded owner/folder. (2) The upgrade requires that browser to obtain a newly bound reminder session. (3) Its old API credential is rejected. (4) The owner chooses a current notification folder and committed reminders generate notifications. (5) The old subscription is still selected because its folder is null. (6) Token pruning cannot associate it with an owner and leaves it eligible. The real D1 reproduction also shows an expired owned subscription selected before maintenance; maintenance removes that row but leaves the legacy row.

The test establishes unauthorized selection, not a real encrypted provider delivery. The sending implementation uses the same permissive predicate. This is an upgrade/privacy boundary issue; a newly created deployment without legacy rows does not have the indefinite legacy case. Deliberately authorized push-only enrollments are separate and must not be confused with unattributable migrated rows.

**Root cause:** Null scope means both “intentionally authorized for all policy folders” and “legacy ownership unknown.” Recipient authorization is partly deferred to scheduled cleanup rather than checked when private content is sent.

**Recommended change:** Quarantine or require re-enrollment of unowned legacy rows. Model authorized push-only enrollment explicitly, and validate the live session's expiry and scope when selecting session-owned recipients. Keep cleanup for storage hygiene, not as the sole authority check. Provide an owner-visible list/removal path for migrated devices.

**Tests proving a fix:** Migrate a real pre-owner schema containing subscriptions, reject old sessions, change the policy folder, run delivery and maintenance in both orders, and assert the legacy device receives nothing. Test exact token-expiry boundaries and missed cron runs. Separately prove explicit push-only enrollments and live folder-bound sessions keep their intended behavior.

The fresh dependency audit and Gitleaks scan are clean. Actions and the scanner binary are pinned; build and publication permissions are separated. This reduces supply-chain exposure without proving dependencies, unavailable Git history or deployed settings are safe. Private vulnerability reporting must be enabled and tested on GitHub; the repository policy alone cannot establish that setting. No previously unknown live credential was found or exposed in this audit.

## 11. Missing test matrix

“Partial” means useful unit/binding coverage exists but not the complete real-client failure sequence. The temporary positive reproductions are evidence of defects, not permanent safety regressions.

| Scenario | Current coverage / adequacy | Required next assertion |
|---|---|---|
| Two offline editors, disjoint and overlapping Markdown | Partial: planner, merge, transfer and CAS tests. | Both client orders converge with every edit retained or explicitly conflicted. |
| Edit/delete in either arrival order | Partial; R01 reproduced at final local boundary. | No write after the preflight check is lost under any trash mode. |
| Rename/edit and rename/rename | Partial path-model coverage. | Crash between add/delete, retain both intended edits, explain duplicate paths. |
| Delete/recreate with same bytes | Good targeted real-binding regression. | Keep old expected revision through queue/retry and reject the delayed delete. |
| Three-client random schedules | Not demonstrated end to end. | Safety throughout arbitrary interleavings and eventual convergence after quiescence. |
| Lost D1 response across all file commit families | Good targeted local D1/R2 coverage. | Keep live/retained references valid through later cleanup, retry and restore. |
| Duplicate create/complete/move/delete web request | Good exact-replay tests. | Preserve one logical result after source moves/deletion and after restart. |
| Edit a draft after an ambiguous committed save | Unsafe: R05 reproduced. | Reconcile original command, retain later edits, submit a new safe intent. |
| PWA stale form versus plugin change | Good semantic revision cases. | Add whole browser/plugin interaction and all field/move combinations. |
| Long offline period / cursor expiry / missing base | Partial. | Safe full reconciliation without silently choosing an older side. |
| Local manifest/cache corruption and quota errors | Partial validation/recovery tests. | Truncated main/temp, IDB abort, disk full; never treat unreadable state as delete authority. |
| Process exit during local apply/checkpoint | Mocked boundary coverage, no physical process-kill campaign. | Restart from every durable step and preserve all unacknowledged bytes. |
| Local project move interrupted after destination write | No durable restart proof. | Repair duplicate identity/location without dropping either edited block. |
| Alarm before projection completes | Existing regression passes. | Keep it while adding every later projection/outbox transition. |
| Alarm after projection/before outbox | Unsafe: R03 reproduced twice. | Never begin sending an obsolete completed/edited occurrence. |
| Same accepted outbox command retried after delivery | Unsafe: R04 reproduced. | One occurrence identity survives acknowledgement loss and DO restart. |
| Push partial success, terminal failures and repair | Partial; R07 diagnostic gap reproduced. | Retain per-recipient progress and expose terminal/overdue state. |
| Online logout with the actual API wrapper | Unsafe: R02 reproduced in both engines. | Actual revoke dispatch, old-token 401, owned subscriptions removed, late writes still fenced. |
| Legacy and expired push recipient authorization | Unsafe legacy case: R06 reproduced. | Migration quarantine and authorization at delivery without relying on cron. |
| Failed saves across reload / cross-tab local clearing | Good Chromium/WebKit coverage. | Preserve exact attempted request separately from later draft edits. |
| Service-worker update across several live releases | Partial cache/lifecycle coverage. | Open old tab, lazy chunk, unsaved editor and offline restart remain usable. |
| UTC, all-day, DST gap/overlap and recurrence progress | Expanded shared domain/form tests pass. | Installed mobile input and notification policy round-trip under multiple locales. |
| Schema migration interrupted with old clients running | Provisioner and protocol tests; hosted behavior unverified. | Real legacy database, partial retry, collisions and delayed old invocation. |
| Recovery archive corruption / unsafe target | Five local archive tests pass. | Retain these rejection guarantees when adding resumable restore. |
| Recovery rate limit / upload acknowledgement loss | Unsafe operational recovery: R08 reproduced. | Honor Retry-After, bounded retry and exact verified checkpoint resume. |
| 1k/10k-note load, large reminder count, low-memory mobile | No measured candidate capacity envelope. | Query/byte/latency/memory budgets, backlog drain time and useful partial state. |
| Plugin unload/reload and app background/resume | Good lifecycle mocks; real host gap. | Repeated enable/disable under active transfers, no stale checkpoint/listener effects. |
| OAuth/push/restore on an independent account | Not performed. | Exact artifact deployment, enrollment, delivery, revocation and paired recovery. |
| Release source/artifact reproducibility and security checks | Fresh local gate/scans pass; prior local cross-Node match. | Hosted matrix and community scanner on the final fixed commit. |

## 12. UI/UX assessment

The candidate now has stronger loading/error states, stable DOM behavior during typing, explicit binary incoming copies, persistent failed drafts, and scoped shared UI styling. All 48 visual/layout/keyboard checks passed without modifying the committed baselines. Browser suites cover synchronous editor focus, undo/redo, paste/composition and pull interaction in both engines. That is useful evidence, not a complete accessibility certification.

The highest-value UX work is accurate state and recovery guidance:

| User-visible situation | Current limitation | Required behavior |
|---|---|---|
| “I logged out.” | Local access clears, remote token remains because of R02. | Confirm remote revocation or show a persistent, actionable local-only outcome. |
| “I corrected the failed draft and retried.” | R05 can repeat 409 across reload. | Explain the unknown earlier outcome, reconcile it and retain the correction. |
| “This reminder is complete.” | R03 can still send the old notification. | Delivery reflects current committed intent; stale alarms are fenced. |
| “The reminder is scheduled but never arrived.” | R07 hides terminal failure behind a remaining scheduled count. | Show delivery failure/overdue state and the appropriate repair action. |
| “A binary file downloaded.” | Incoming content may await explicit review. | Make original/incoming roles and pending resolution clear across restart. |
| “My deleted file came back.” | Edit-wins and rename conflicts deliberately preserve data. | Explain which competing edit survived and where conflict copies live. |
| “My backup/restore stopped.” | R08 requires a new attempt/target with little resumable progress. | Preserve a verifiable checkpoint and state exactly what remains offline. |

Before public release, test keyboard-only navigation and screen-reader announcements in the real Obsidian host, touch targets and safe areas in installed mobile web apps, reduced motion, focus restoration, long translated/device names, and 200% text scaling. The present tests do not establish WCAG conformance or physical mobile usability. Keep user-facing errors focused on the retained data and next action; request IDs and revisions belong in expandable support detail.

## 13. Performance/scalability assessment

Individual operations are better bounded. Shared sync limits cap files at 25 MiB, upload batches at five files, delete batches at six, and downloads at 50 files/8 MiB. Web index warming reads at most 20 files and 2 MiB per request; individual notes are capped at 1 MiB and oversized parsed cache records become per-file issues. The coordinator processes three source files and five notification jobs per alarm; push delivery uses six concurrent send workers and a ten-second request deadline.

These limits protect invocations, but do not establish a complete vault capacity envelope. Warm-index requests still enumerate folder metadata, and the final list/cache/UI working set grows with total reminders. A 10,000-note cold index needs at least 500 warming batches from the file-count cap alone, potentially more from the byte cap. This is a code-derived lower bound, not a measured latency result. Projection backlog drain time also depends on reminders per file and outbox retries, not just source-file count.

Fresh size measurements passed, with little room in some budgets:

| Artifact | Measured | Configured budget |
|---|---:|---:|
| Plugin JavaScript, raw | 1,341.67 KiB | 1,416.02 KiB |
| Plugin JavaScript, gzip | 739.77 KiB | 800.78 KiB |
| Plugin stylesheet, raw | 135.75 KiB | 136.72 KiB |
| Worker bundle, gzip | 553.28 KiB | 600.59 KiB |
| PWA app module, gzip | 34.89 KiB | 35.16 KiB |
| PWA startup assets, gzip | 129.49 KiB | 129.88 KiB |

Keep these gates; do not enlarge a budget automatically when a fix crosses it. Measure parse/startup and memory on low-end devices before deciding whether the embedded Worker, UI library imports, CSS or eagerly loaded reminder data deserves optimization. The browser interaction checks pass, but they are not a 10k-note memory/load benchmark.

**Receipt growth — MEDIUM, confidence High, architectural risk.** `reminder_operations` and creation identities have no bounded retention/storage policy in the reviewed maintenance path. A long-lived, frequently edited vault accumulates receipts indefinitely. Permanent creation identity is useful for deduplication; indiscriminately deleting it would break that guarantee. Define separate lifetime rules for compact identities and full response receipts, with a protocol for clients retrying beyond the retention horizon. Test storage growth and ancient retries. D1's published database caps are 500 MB on Free and 10 GB on Paid, so indefinite metadata growth eventually matters even without large note bodies. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Before declaring scale support, run 1k/10k-note workloads with small and near-limit notes, many reminders in one note, concurrent PWA polling, bulk rename/delete, weeks of retained versions, cold caches and a stopped/restarted coordinator. Record D1 statements/rows, R2 operations, Worker CPU, browser/plugin heap, p95 latency and backlog age. Recovery also needs rate-aware object transfer as described in R08. A modest documented support envelope is preferable to unmeasured “large vault” claims.

## 14. Open-source readiness

The repository has a usable contribution foundation: license and third-party notices, security policy, architecture/protocol/API documentation, deployment and recovery guidance, an explicit release checklist, and locked npm tooling. The current full gate is reproducible locally and visual snapshots now pass on their intended platform. Build/release artifacts are generated outside tracked source, tags must match the manifest, and publication is separated from dependency installation/build privileges.

Remaining readiness work is principally verification and operational accuracy. The exact commit needs hosted CI on the supported Node matrix, an Obsidian community review scan, the minimum supported host version, and independent-account OAuth/deployment/push/restore checks. The site privacy page and live OAuth callback should be compared with source without assuming a local build publishes them. No deployment or publication was performed in this task.

The README/protocol claims about logout and subscription revocation need to be revalidated after R02/R06. Notification scheduling documentation should state the distinction between source projection, accepted schedule and completed delivery, and explain terminal failures once R07 is fixed. Treat the earlier “all findings fixed” remediation statement as historical implementation progress, not the final release decision.

### R08 — Recovery has no transient retry or safe resume after partial restoration

**Severity:** MEDIUM. **Confidence:** Confirmed for controlled transport/interruption; hosted frequency unmeasured. **Category:** Confirmed operational recovery limitation. **Area:** Paired backup/restore CLI.

**Problem and impact:** The [Cloudflare transport][recovery-transport] converts every HTTP error, including 429 with `Retry-After`, into an immediate failure. [Backup][recovery-backup] writes into a new directory and has no checkpoint resume. [Restore][recovery-restore] requires empty resources on every invocation, then uploads and reads back objects one by one before importing D1. A transient failure after an upload leaves a nonempty target which the next run rejects.

**Failure sequence:** (1) A valid paired archive targets new empty resources. (2) The first R2 object is uploaded successfully. (3) Its acknowledgement is lost, or a later request receives 429. (4) Restore stops before completing the database import. (5) The operator reruns the same command after connectivity recovers. (6) The empty-target check rejects the already uploaded object, so the command cannot resume. The reproduction confirms the target retains bytes, D1 is not published, and the second invocation refuses it. A separate transport test confirms one 429 produces exactly one attempt despite `Retry-After`.

Cloudflare currently limits account-level R2 REST API operations to 1,200 requests per five minutes and recommends the S3-compatible or Workers API for high-throughput object work. Backup needs one GET per referenced object; restore needs at least a PUT and verification GET per object. Large archives or shared account traffic therefore need deliberate pacing/retry. Whether a particular run hits the quota depends on object size, network latency and other traffic. [Cloudflare R2 REST limits](https://developers.cloudflare.com/r2/platform/limits/)

**Root cause:** “Target must initially be empty” is enforced on every attempt, with no distinction between unrelated data and verified progress from this archive. Transport retries and durable transfer identity were omitted from the otherwise conservative paired-restore design.

**Recommended change:** Honor Retry-After and bounded exponential backoff for appropriate transient failures. Add a durable checkpoint bound to archive digest and exact destination resources. Resume only objects whose existing bytes verify against that archive; reject unexpected content. Keep the source-resource prohibition and object-before-metadata ordering. Consider an authorized data-plane transfer path for large archives. The original archive and source remain intact in the reproduced case; this is an availability/recovery-time problem, not demonstrated new source data loss.

**Tests proving a fix:** Inject 429, 5xx, timeouts before/after PUT, lost D1 import acknowledgement, restart and checkpoint corruption. Resume into the same isolated target without overwriting unexpected data. Verify every object and database row, plus receipts, policy and re-enrollment resets. Then complete a hosted paired restore in an independent account with enough objects to exercise pacing.

## 15. Recommended release plan

### Must fix before release

1. **R01:** Make local deletion recoverable under concurrent writes and all host trash settings. The proof must include the exact removed bytes and restart behavior.
2. **R02/R06:** Close the session-to-recipient boundary. Prove real online logout revokes the token, remove/quarantine unowned migrated subscriptions, and authorize recipients at delivery time.
3. **R03/R04:** Introduce a durable versioned occurrence lifecycle across source projection, outbox acknowledgement and delivery. Prevent obsolete sends and duplicate accepted-command effects.
4. Add permanent regression tests for those fixes, using actual adapters/wrappers/handlers where the original tests hid the composition. Preserve the previous lost-commit, stale editor, delete/recreate and timezone tests.
5. On the final fixed commit, complete the existing release checklist: fresh release/scans/visual checks, hosted CI/artifact reproducibility, community review, physical Obsidian/mobile and independent-account deployment, revocation, push and paired restore. These are validation gates, not a request to deploy the currently audited candidate.

### Should fix before release

1. **R05:** Separate immutable attempted commands from editable drafts and provide successful reconciliation after an ambiguous save.
2. **R07:** Surface terminal delivery failures and overdue age, ideally in the same occurrence record used by R04.
3. **R08:** Add rate-aware transport and verified resume; rehearse an interrupted restore into the same target.
4. Journal or repair interrupted local project moves, and prove mixed-version migration/draining behavior.
5. Publish measured vault/reminder limits and accurate conflict, binary-review, logout and recovery guidance. State the receipt retention policy before growth becomes operationally significant.

### Can safely follow after release

- Broader property-based concurrency campaigns and ongoing low-end-device performance monitoring, after the release-critical cases pass.
- More automatic disjoint field merging and rename-following UX, provided current conflict outcomes continue preserving content.
- Targeted dependency/CSS trimming and feature laziness informed by startup profiles.
- Routine module simplification and additional contributor examples where they reduce onboarding cost.

Do not tag/publish the current candidate or compensate for R01 with a backup disclaimer. The fixed candidate needs its own audit identity and verification record.

## 16. Highest-value improvements

If only five improvements fit before release, prioritize these cohesive changes:

1. **A recoverable local delete protocol.** This closes the only demonstrated route in this re-audit to losing a never-uploaded edit.
2. **One durable notification occurrence identity.** Carry current intent through projection, scheduling, replay, recipient progress and terminal outcomes; this addresses R03/R04 and enables R07.
3. **An end-to-end credential/recipient lifecycle.** Real online logout, legacy quarantine and send-time authority checks close R02/R06 together.
4. **Acknowledgement-aware editing.** Preserve both the original attempted command and subsequent draft changes so retries can recover without duplication or permanent conflict (R05).
5. **A restartable paired recovery path with a hosted rehearsal.** Retry/rate handling, verified checkpoints and an independent restore make the recovery promise operational (R08).

Each improvement should be accepted only with its fault-injection proof. The external release checklist remains necessary even if these five are implemented.

## 17. Release-readiness score

| Area | Score / 100 | Main factors |
|---|---:|---|
| Architecture | 84 | Clear responsibilities, shared domain and better commit effects; lifecycle identities still fail across joins. |
| Sync correctness | 78 | Strong CAS/merge/cursor/revision behavior; local delete and real multi-client crash coverage remain incomplete. |
| Data safety | 55 | Original remote loss/stale overwrite paths fixed; R01 can still erase a never-uploaded edit. |
| Backend reliability | 70 | Durable queues, bounded work and real bindings; stale/duplicate notification delivery and terminal visibility remain. |
| Obsidian plugin | 75 | Stronger writer/lifecycle behavior; destructive host boundary and physical-device verification remain. |
| PWA | 76 | Both engines pass, drafts/cache/state improved; real logout and ambiguous edited retries fail. |
| Security | 70 | Scoped sessions, provider controls and clean scans; logout and legacy recipient authority need correction. |
| Testing | 80 | Full release gate and 48 visual checks pass; new composed failure cases expose important blind spots. |
| UI/UX | 83 | Stable interaction and consistent presentation; some success/scheduled/retry states do not reflect durable reality. |
| Open-source readiness | 85 | Good licensing, documentation, CI and tooling; hosted/physical release evidence and recovery resilience outstanding. |

**Overall: 76/100**, approximately the mean of these areas, with release approval separately gated by safety. This improves on the original 57/100 because the repairs are substantive and the complete local gate is green. It is not a probability of correctness or a substitute for meeting the blockers.

The score is held below release approval by the unpreserved local delete interval, incomplete credential revocation and migrated recipient authority, notification causal/idempotence gaps, and missing hosted/physical validation. Medium-priority draft/diagnostic/recovery defects further increase support cost.

**Would I personally approve this repository for public release today? No.** Fix R01 and the high-priority session/notification findings, then validate the exact fixed candidate through the local and external release gates. The current passing tests and substantial improvements justify continuing toward release, but do not establish the required content-preservation and authorization guarantees.

[evidence]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/96f9469/README.md
[local-delete]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/planner-helpers.ts:68
[delete-transfer]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/transfer-process.ts:165
[logout]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/hooks/usePwaSessionLifecycle.ts:15
[pwa-api]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/api.ts:26
[projection]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-projection.ts:19
[alarm-deliver]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notifications/reminder-alarm.ts:193
[alarm-fetch]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notifications/reminder-alarm.ts:71
[alarm-retry]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notifications/reminder-alarm.ts:255
[diagnostics]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/maintenance/diagnostics.ts:9
[pwa-mutations]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/hooks/useReminderMutations.ts:80
[drafts]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/reminder-drafts.ts:8
[operations]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/operations.ts:11
[scope-migration]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/migrations/0007_web_scope.sql:1
[push-recipients]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notifications/push.ts:99
[recovery-transport]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/scripts/recovery/cloudflare.py:24
[recovery-backup]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/scripts/crate-recovery.py:14
[recovery-restore]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/scripts/crate-recovery.py:50
[local-move]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/data/markdown-writer/update.ts:46
[provisioner]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/provisioner.ts
[release-checklist]: /Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/release-checklist.md
