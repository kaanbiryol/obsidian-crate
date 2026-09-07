# Crate pre-release engineering audit — 67cd40c

Date: 2026-09-06. Candidate: `67cd40c1fdb6985bfccbf17e6babb8e8aa33c145` on `master`; version 0.1.0, protocol 5, D1 schema 2. This review follows the enrollment/lifecycle fixes and a further correction found during the repeat review. Unrelated website edits are outside this candidate. The repository is already public; the approval below concerns publishing the plugin release.

## 1. Executive summary

The two previously reproduced medium defects are resolved. Enrollment consumption, new session creation and replacement-session revocation now share one guarded D1 transaction. Plugin shutdown invalidates the startup attempt before teardown, including pending settings and reminder scans. The obsolete standalone enrollment-consumption helper and its mock-only tests were removed; real local D1 tests now exercise rollback and concurrency.

The repeat analysis found and fixed one related UI handoff defect: changing folders while the first reminder scan was pending could leave the new index active without reminder commands or a registered view. The overlap test reproduced zero view registrations; the winning initialization now registers integrations through the existing idempotent registration function. The final regression passes.

**No unresolved confirmed code defect was established in this repeat review.** That conclusion is bounded by source review, local Cloudflare execution, automated browser engines and the tested scenarios. It does not establish physical host or hosted-account behavior. Earlier fixes to post-download checkpoints, notification observation time, duplicate identity handling and fresh PWA sessions remain covered and passed again.

The remaining findings are G01, a HIGH candidate-validation gap; G02, a MEDIUM aggregate-capacity risk; and G03, a MEDIUM repository-protection gap verified through the GitHub API. Private vulnerability reporting is enabled, closing that part of the previous uncertainty. No BLOCKER or CRITICAL code issue, new vault-data loss, cross-folder disclosure or remote-code execution was confirmed.

**Readiness: 89/100. Public release approval today: No**, until the candidate's account/recovery/device evidence is complete. The next work should be a release rehearsal with measured limits and repository protections, followed by publication checks.

| Verification | Result and scope |
|---|---|
| Final `npm run release:check` | Passed: lint, plugin/Worker types, dead-code analysis, notices, recovery, unit/Worker tests, build, CSS, budgets, artifacts and browser safety |
| Unit tests | 1,011 passed in 175 files |
| Local Cloudflare runtime tests | 73 passed in 10 files |
| Recovery tests | 17 passed |
| Chromium and WebKit | Cache, focus, editing, draft persistence, logout, session recovery and folder replacement passed |
| Visual tests / visual types | 48 passed / passed; shared UI rendering source unchanged by the final handoff correction |
| Dependencies / secrets | Zero reported npm advisories; Gitleaks passed history and current source |
| Clean source builds | Locked install and exact Node 20.19.0, 22.12.0 and 24.0.0 builds passed; release artifacts match |
| GitHub inspection | Public repo, private reporting enabled, no active rules on `master`, scanning/push protection/security updates disabled |
| Physical devices, independent Cloudflare account, hosted capacity | Not exercised in this audit |

Commands, candidate hashes, before/after regression evidence and the precise version/build scope are recorded in [the evidence index](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2026-09-06-lifecycle-enrollment/README.md). The full CI suite was run locally on Node 24.0.0; the other two versions were used for build reproducibility. This is not a claim that remote Actions has run on these local commits.

## 2. Release blockers

No unresolved code finding meets the requested BLOCKER or CRITICAL definition. **G01 still prevents engineering sign-off**: the exact assets need a clean minimum-version Obsidian installation, independent-account OAuth, paired D1/R2 recovery into isolated resources, and physical iOS/Android sync and installed-PWA push validation. Passing component tests cannot prove account permissions, host adapters or operating-system suspension behavior.

Keep the current-format contract explicit. Provisioning and recovery accept schema 2; incompatible mutation clients are rejected by protocol 5. Unsupported databases must remain unmodified. Use isolated current resources for the rehearsal. No migration engine, historical adapter or removed feature is required to release this candidate.

## 3. Critical/high-priority findings

There are no open confirmed code defects from this pass. The remaining findings are detailed in sections 10, 11 and 13, with evidence and proving criteria. The closed defects deserve a precise record:

| Closed finding | Failure sequence | Final protection and proof |
|---|---|---|
| R01, MEDIUM enrollment rollback | Redeem link; separately consume it; session transaction fails; retry gets 401 without a new session | Session insertion selects the unexpired enrollment row, then guarded consumption and replacement revocation occur in one D1 batch. SQL failures injected at every statement boundary preserve the link, old session and subscription. Four concurrent exchanges produce one 200 and three 401 responses. |
| R02, MEDIUM startup after unload | Start bootstrap; pause settings/connection/index/sync; unload; pending work resumes and constructs resources | A plugin lifetime signal is captured at entry and checked across awaits. Shutdown aborts before teardown; stale settings cannot overwrite the current global store. Cancelled scans do not publish a backend or normalize IDs in a later atomic callback. |
| R03, MEDIUM missing UI during folder handoff, found and fixed here | Initial scan pauses; folder change loads a replacement; initial scan is cancelled; neither path registers reminder UI | The successful folder replacement also performs idempotent integration registration. The overlap test checks one watcher, one view, one command-registration call and retention of the newer index. |

Relevant implementation: [enrollment handler](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-enrollment-handlers.ts), [lifecycle](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/plugin/lifecycle.ts), [lifetime ownership](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/plugin/lifecycle-state.ts), [reminder backend](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/runtime.ts), [integration handoff](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/plugin-integration.ts). Evidence: [enrollment integration tests](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/enrollment-recovery.integration.ts), [lifecycle tests](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/plugin/lifecycle.test.ts), [settings tests](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/plugin/CratePlugin.test.ts), [scan cancellation](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/data/vaultScanner.test.ts), [handoff regression](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/plugin-integration.test.ts).

The enrollment contract distinguishes rollback from response loss **after commit**. In the latter case the credential was issued and the link remains consumed; recovery requires a fresh link. This is tested and documented, without granting reusable enrollment authority. Cancellation similarly cannot undo a host write already dispatched before abort; it prevents later initialization, scan mutations at checked boundaries and stale publication.

## 4. Sync correctness assessment

The plugin compares local content, its acknowledged baseline and remote metadata. Filesystem events enter a coalescing queue; periodic/foreground reconciliation recovers missed events. Incremental changelog pages use cursors, with full paginated reconciliation when history has expired. The Worker stages immutable R2 content, then conditionally commits authoritative D1 references, changelog, retention and notification projection intent.

Upload hash preconditions reject stale writers. Delete preconditions include the opaque object revision so an old deletion cannot remove an identical-content recreation. Verified downloads use guarded text writes; Markdown merging uses the common base. Binary conflicts preserve an incoming review copy. Local remote-deletion handling uses vault trash. Force upload does not proceed to destructive remote deletion after failed uploads.

A successful local application records clean metadata only after a stable read verifies the applied bytes. If another writer changes or removes the file, the baseline retains unverified metadata, forcing the next comparison to hash. The single-download, batch-download and merge regressions persist/restart before checking that the newer local edit is uploaded. Checkpoint generations and serialized writes recover the newest valid main/temp state.

| Multi-client scenario | Current outcome | Evidence boundary |
|---|---|---|
| A and B edit one note offline | Stale CAS fails; merge or preserved conflict retains competing content | Model/classification, transfer and local storage integration |
| A edits / B deletes, either order | Changed content is reconciled; preservation may intentionally retain/recreate a path | Both-order components; physical filesystem sequence pending |
| A renames / B edits old path | Rename is delete/create, so the new path and edited old path may both survive | Path planning and preservation; not a distributed atomic rename |
| A and B rename differently | Both destinations may survive | Full two-host trace still needed |
| Delete, identical recreation, stale delete replay | Incarnation revision rejects the old delete | Real local D1/R2 integration |
| Three clients edit related files | Per-file CAS and pair-write guards hold; there is no general multi-file vault transaction | Randomized three-runtime convergence still missing |
| PWA stale editor after plugin update | Semantic reminder revision and file CAS reject stale whole-form edits | Local Worker integration and browser components |
| File/reminder operation commits, response is lost | Verified identical upload or stored operation receipt makes the retry safe | Lost-response fault injection, including recurrence and moves |
| Client crashes during application/checkpoint | Verified baseline and checkpoint recovery preserve detectable divergence | Persist/restart tests; actual process kill pending |
| Weeks offline | Expired cursor falls back to manifest reconciliation | Components; large changing hosted history pending |
| R2 bytes missing/corrupt | Hash/size verification rejects application | Local fault injection |

The local metadata fast path still assumes an external tool does not silently replace same-length bytes while preserving modification time and producing no event. A deliberate integrity scan would strengthen that boundary. This is an explicit residual assumption, not a new reproduced ordinary-write regression.

## 5. Sync threat model

| Threat | Protection | Residual exposure |
|---|---|---|
| Older content overwrites a newer note | CAS, semantic revisions, guarded writes, common-base merge | Actual host event timing and external metadata preservation |
| Deletion loses conflict bytes | Trash, conflict/review copies, retained remote versions | Retention is finite; it is not an independent backup |
| R2/D1 partial commit corrupts references | Immutable staging, guarded D1 batch, reference-aware uncertain-object cleanup | No cross-service transaction; operational recovery matters |
| Duplicate/out-of-order mutation | Preconditions, receipts tied to request identity, source/policy/job fences | External push acknowledgement cannot guarantee exactly-once visible delivery |
| Divergence after interrupted checkpoint | Generations, strict format checks and verified applied-content baseline | Corrupt unsupported state may require explicit recovery |
| Duplicate reminder identities | Source ownership, quarantine, actionable issues and mutation rejection | Ambiguous Markdown must be repaired before derived behavior resumes |
| Stale notification after edit/delete | Source revision, policy revision and delivery token checks | Push already accepted by a provider may arrive later |
| Startup continues after disable | Lifetime abort, runtime teardown, scan cancellation | Host operations dispatched earlier may finish |
| Stolen browser token accesses vault | Exact folder binding, route allowlist, expiry and revocation | Bearer possession grants its scope until revoked/expired |
| Mixed backup becomes unrecoverable | Paired archive checksums, isolated target, resumable import and row comparison | Independent-account rehearsal remains G01 |

Vault contents are not end-to-end encrypted against the owning Cloudflare account. Push payload encryption and folder-scoped browser credentials serve narrower boundaries. There was no newly confirmed cross-user or cross-folder leak.

## 6. Architecture assessment

The main entry shell delegates plugin lifecycle and settings, sync planning/transfers/checkpoints, reminder indexing/writes and UI ownership. Worker routes and storage mutations keep backend authority separate from client sync decisions. Shared Markdown parsing, reminder dates and semantic revisions reduce plugin/PWA rule drift. The PWA edits authoritative Markdown through server commands; it does not introduce a second authoritative reminder database.

The enrollment change restores transaction ownership to the exchange boundary. Plugin lifetime and reminder-backend attempt ownership are separate small mechanisms: unload cancels all work for that plugin lifetime, while a folder replacement cancels only the superseded backend. Local construction followed by guarded publication prevents old scans from replacing newer state.

R2 stores bytes, D1 owns references/receipts/source observations, and Durable Objects coordinate scheduling/delivery. No additional queue, KV or WebSocket abstraction is needed for the inspected design. Whole-folder materialization remains the practical scalability weakness in G02. Large coordinators should be split only when doing so clarifies an actual state-machine responsibility; file length alone is not a release defect.

Both Knip modes pass. The unused consume helper is gone. Current schema rejection, retry recovery and retention of static assets still used by open browser clients are active safety behavior. No legacy parser, migration chain or newly confirmed dead production feature remains in the inspected paths; static analysis cannot prove that every dynamic UI path is useful.

## 7. Cloudflare/backend assessment

The storage primitives fit a personal-vault deployment. D1 batch semantics provide the transaction needed by enrollment: a failing statement rolls back the sequence. The new real-runtime tests verify this behavior around all exchange effects. [Cloudflare D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/).

R2 strong read/write/list consistency supports verifying immutable objects before use, but supplies no atomicity with D1. The implementation therefore retains uncertain staged objects and checks live/retained references during cleanup. [Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).

File commits also record reminder identity ownership and the first observation of an occurrence. Projection checks committed bytes and source/policy/job revisions. A delayed job can still deliver an occurrence originally observed before its due time; newly imported historical occurrences are cancelled. Delivery beyond the documented 24-hour lateness window records a failure. Duplicate identities block ambiguous projections and trigger reconsideration after repair, including deletion of a duplicate source.

Per-request batch limits, payload limits and SQL binding bounds control individual work units. The inspected upload/delete limits are three/four files. D1 currently documents 50 queries per Free invocation, 100 bound parameters and a 2,000,000-byte value/row limit. Aggregate CPU and response memory remain separate constraints. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Maintenance bounds each cleanup/projection pass and recovers missed wakeups. Durable receipts protect recurrence, deletions and notification replay; arbitrary retention of these records would weaken retry guarantees. Hosted backlog age, database growth, cold indexing and operational cost need measurement before claiming a broad support envelope.

## 8. Obsidian plugin assessment

Startup creates lifetime ownership before its first await. Unload aborts before runtime/service/watcher teardown. Deferred settings from an old instance cannot replace a newer instance's reminder settings. The regression matrix covers settings, managed-connection restoration, reminder loading, sync initialization, overlapping startup and layout-ready callbacks.

Reminder scan cancellation reaches the vault read and atomic normalization callback; stale results cannot publish a backend. The winning folder initialization supplies its own writer/index callback and registers UI once. Existing runtime revisions continue to prevent a destroyed sync engine from resuming event capture.

Vault APIs, guarded Markdown writes, conflict preservation, case/Unicode portability checks and iterative hidden-file discovery are appropriate. Consent is persisted before scanning/normalizing reminder files; connecting alone does not initiate vault transfer. Actual host listener disposal, external-plugin interaction and adapter latency still need a real installation.

The manifest declares minimum Obsidian 1.13.0 and mobile support. Types against 1.13.1 are not evidence of 1.13.0 runtime behavior. Test the exact advertised minimum, disable/re-enable during slow work, startup edits, foreground/background, rename/delete and binary conflict recovery on supported devices.

## 9. PWA assessment

The PWA caches static application assets separately from its private IndexedDB reminder snapshot and local drafts. Request/session generations prevent stale reads and logged-out responses from repopulating current state. Failed saves preserve drafts through reload, and retry identity prevents an already committed recurring action from advancing twice. This is not a universal offline mutation queue; connectivity requirements should remain accurately described.

Fresh links replace stored browser authority, clear old folder state and coordinate replacement across tabs. Browser/install credentials are distinct. Enrollment rollback now preserves retryability; a committed exchange remains single-use after response loss. Invalid/expired enrollment cannot revoke a previous valid session.

The service worker uses explicit update activation and preserves static chunks required by open clients. Unknown client versions conservatively postpone cache collection. The API enforces current mutation protocol independently of shell caching. No private API-response caching was identified in the static service-worker strategy.

Browser engines cover focus, editor history/composition/paste, node reuse, viewport batching, cache refresh, drafts, logout and cross-tab replacement. Installed mobile update transitions, storage eviction/deletion blocking, OS permission changes and push-subscription renewal remain physical-device tests. Date/recurrence logic shares parsing and preservation helpers; timed reminders retain their instant on title edits, all-day scheduling uses the saved timezone policy, and recurrence retries use receipts.

## 10. Security assessment

Authentication hashes bearer tokens and fails closed on D1 errors. Reminder credentials are restricted by both route and exact folder. Push subscriptions are owned by authenticated sessions; destinations are checked against permitted HTTPS providers with redirect/deadline controls. Protocol checks reject incompatible mutation requests. Existing security and replay integration cases passed.

Deployment bundles and verifies Worker/schema content at build time. OAuth uses state and PKCE; temporary authority is not persisted as a second long-lived secret. No fetched-code execution, hidden telemetry or newly confirmed injection was found. The advisory and history/current-source secret scans are clean, within the limits of those tools.

### G03 — Repository controls do not enforce the intended release process

**Severity:** MEDIUM. **Confidence:** Confirmed. **Classification:** Missing protection/test. **Area:** Source and release supply chain.

**Problem:** GitHub reports `master` unprotected and its active branch-rules endpoint returns an empty array. Repository security settings report secret scanning, secret push protection and Dependabot security updates disabled. Private vulnerability reporting is enabled. These are hosted settings, independent of the committed workflows.

**Why it matters / concrete scenario:** A future direct push can land a failing or credential-containing change before CI reports it; subsequent cleanup does not make an exposed credential secret again. This is a plausible process failure, not evidence of an existing leak or compromise. The release workflow still runs its own safety gates before publishing.

**Relevant evidence/root cause:** [repository settings snapshot](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2026-09-06-lifecycle-enrollment/github-repository.json), [active branch rules](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2026-09-06-lifecycle-enrollment/github-master-rules.json), [release workflow](/Users/kaanbiryol/Documents/Projects/obsidian-crate/.github/workflows/release.yml), [security workflow](/Users/kaanbiryol/Documents/Projects/obsidian-crate/.github/workflows/security.yml). Checks exist in source, but branch admission and pre-push secret protections are not enabled.

**Recommended change:** Configure a ruleset for `master` requiring the actual passing CI/security check names and blocking deletion/force pushes; choose an appropriate maintainer bypass and review policy. Enable secret scanning, push protection and security-update PRs. Verify release-tag authority before the first tag. These settings were inspected, not changed during this audit.

**Proving checks:** Read back the effective rules and enabled security statuses; verify a deliberately failing test branch cannot satisfy merge requirements. Confirm the documented vulnerability-reporting URL opens. Do not test push protection with a real secret.

## 11. Missing test matrix

“Component” means automated coverage of the stated boundary, not a complete real-device distributed run.

| Scenario | Adequate local evidence | Remaining verification |
|---|---|---|
| A edits / B edits | CAS, merge, conflict and reconciliation components | Two installed clients converge with preserved conflicts |
| A edits / B deletes, reverse order | Both-order models and guarded delete components | Actual trash and filesystem event order |
| Rename/edit and competing renames | Path and preservation components | Full interrupted multi-device traces |
| Delete/recreate/stale delete | Real D1/R2 incarnation regression | Repeat on physical hosts |
| Three-device concurrent related changes | Per-file/pair-write boundaries | Randomized three-runtime scheduling |
| Stale PWA writes after plugin updates | Semantic revision integration | UI-to-host round trip |
| Weeks offline | Expired cursor/full-manifest components | Large history with active writers |
| Failure before/during transfer | Queue, retry, abort and partial-batch tests | Hosted connection and mobile suspension |
| Failure after server commit | File, create, recurrence, delete and enrollment cases | Hosted trace and user recovery |
| Duplicate/out-of-order operations | Receipts, CAS, source/policy fences | Randomized mixed-operation histories |
| Crash during local apply/checkpoint | Persist/restart and corrupt-state recovery | Kill real Obsidian during disk operations |
| R2/D1 failure and corrupted remote bytes | Local integration fault injection | Hosted paired recovery |
| Migration failure / unsupported schema | No migration feature; strict rejection and current initialization retry tested | Independent deployment rejection without modification |
| Old frontend/new backend | Version fencing and shell-lifecycle tests | Two installed asset versions during rollout |
| Multiple tabs/logout/folder replacement | Chromium/WebKit safety tests | Installed/browser combination on devices |
| Notification lateness, duplicate IDs, moves | Local Worker regressions | Provider receipt, cron recovery and real device delivery |
| Enrollment transaction rollback/concurrency | Five SQL boundaries, one winner, invalid/expired and lost-response cases | Hosted deployment rehearsal |
| Unload during initialization | Deferred boundaries and real settings-store isolation | Host disable/re-enable while busy |
| Initial scan overtaken by folder replacement | New UI/watcher registration regression | Slow-vault settings interaction |
| 1k/10k notes | Prior-candidate warm list fixture, unchanged handler | Current hosted cold/warm CPU, memory and full sync |
| Independent account / minimum host / physical push | Not completed | G01 |

### G01 — Candidate-specific account, host and recovery proof is incomplete

**Severity:** HIGH. **Confidence:** Confirmed. **Classification:** Missing protection/test. **Area:** Release validation and recoverability.

**Problem/impact:** There is no completed record showing these exact assets can enroll an account unrelated to the OAuth publisher, restore a paired archive into another account, run on minimum Obsidian, and deliver scheduled push on physical iOS/Android. Local execution cannot verify account permissions or operating-system behavior.

**Concrete scenario:** All automated checks pass, but a new account cannot complete setup, a restored deployment cannot re-enroll devices, or a suspended mobile client fails to resume. These are required test scenarios, not observed product failures.

**Relevant files/root cause:** [release checklist](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/release-checklist.md), [recovery runbook](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/recovery.md), deployment service, plugin lifecycle and push delivery. The required execution environments are outside the local evidence collected here.

**Recommended change/proving tests:** Use a non-critical vault and isolated resources. Record artifact hashes, host/OS versions, independent OAuth enrollment, explicit initial upload, restart/reconnect, conflicts, scheduled push, paired backup/restore, file/receipt equality and re-enrollment. Preserve the original vault and deployment throughout. Close the gap with actual results; do not infer a pass from mocks or templates.

## 12. UI/UX assessment

The product surfaces sync activity, conflicts/review copies, partial failures, explicit overwrite/deletion confirmation, offline/cache state, retained draft errors and session renewal. Duplicate identity issues point to affected Markdown, and late-delivery failures reach diagnostics. The startup handoff fix restores reminder view/command availability in the tested race.

The shared visual suite passes 48 cases. Browser interaction tests cover useful input/focus behaviors. No further concrete visual defect was established in the unchanged shared UI. Physical VoiceOver/TalkBack, keyboard overlays, touch targets under real safe areas, notification prompts and third-party Obsidian themes remain unverified.

Conflict-preserving renames can leave two paths by design; release documentation should describe this outcome and show how to review it. A lost enrollment response after commit needs a fresh link, so retain actionable renewal copy. No cosmetic redesign is necessary to close the current release risks.

## 13. Performance/scalability assessment

### G02 — Aggregate folder work lacks a tested hosted operating envelope

**Severity:** MEDIUM. **Confidence:** High. **Classification:** Architectural risk. **Area:** Worker/PWA capacity, mobile startup and cost.

**Problem:** A reminder list loads whole-folder file metadata, and a warm 200 response loads/parses all matching cached records and computes reminder revisions. Even 304 computes a folder-wide revision. Cold indexing is bounded to 20 files and 2 MiB per request while repeating aggregate work. Long-lived occurrence and operation records also accumulate.

**Why it matters / concrete scenario:** A 10,000-file cold folder needs at least 500 list attempts, potentially more for larger files. Concurrent clients multiply metadata reads, serialization and memory pressure. Deep vaults add hidden-file discovery cost. No hosted CPU exhaustion or out-of-memory failure was demonstrated here.

**Relevant files/root cause:** [list route](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/routes/list.ts), [cache aggregation](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/reminder-cache.ts), [cache limits](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/reminder-cache/types.ts), [file discovery](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/file-discovery.ts), [occurrence observations](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-projection-queue.ts). Per-file bounds do not bound total folder work or retained history.

**Recommended change/proving tests:** Measure hosted 1k/10k cold/warm indexing, initial/incremental sync, dense reminders, deep trees and multiple clients. Record CPU, heap, D1 reads/queries, R2 requests, time to convergence, backlog age and mobile UI latency. Publish the passing initial envelope. Add persistent folder revisions and paginated/indexed aggregates if the intended workload fails. Define retry-safe compaction before deleting receipts or occurrence records.

The previous candidate's warm local list fixture remains relevant because these paths are unchanged, but it was **not rerun as a new hosted benchmark**:

| Files/reminders | Response bytes | Median local 200 wall time | 200 D1 queries | Median local 304 wall time | 304 queries |
|---|---:|---:|---:|---:|---:|
| 1,000 | 286,930 | 15 ms | 3 | 3 ms | 1 |
| 10,000 | 2,878,930 | 123 ms | 3 | 18 ms | 1 |

Those fixtures checked completeness, uniqueness and conditional responses, excluding authentication, R2 cold reads, hosted networking/CPU and mobile rendering. [Historical measurement evidence](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2026-09-06-source-integrity/capacity-results.json).

Cloudflare currently documents 10 ms CPU for Free HTTP requests and 128 MB memory per isolate. Waiting on database/network work does not count as CPU, so these local wall times cannot establish a quota violation or a passing hosted budget. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

All bundle budgets pass without increases. PWA startup remains 129.73 KiB gzip against 129.88 KiB; the app is 34.84 against 35.16 KiB. This small headroom warrants care during later feature work. Exact plugin/Worker sizes are retained in the final release log.

## 14. Open-source readiness

README and architecture/protocol/API/deployment/recovery/testing guides, AGENTS instructions, 0BSD licensing, security policy and generated notices provide a useful release base. The release workflow checks the tag/version, validates on three exact Node versions, compares assets, attests outputs and separates publication authority from the build job. No GitHub release was listed during inspection.

The hosted repository is public and private reporting is enabled. G03 identifies the controls still missing around source admission and secret prevention. CI configuration alone does not prove required checks are enforced. Obsidian community **Review branch** results and scanner reproduction remain release gates, as do live privacy/OAuth callback verification.

Unsupported formats are rejected instead of upgraded. Recovery preserves current operation/identity/occurrence authority while rebuilding derived state and requiring new credentials. There is no reason to add legacy compatibility to improve readiness. Contributor templates and a focused contribution guide are useful later, not grounds for more release-blocking refactoring.

## 15. Recommended release plan

**Must complete before release**

1. Freeze this candidate and copy its exact hashes into the release checklist. Any later code change requires appropriate checks and refreshed hashes.
2. Complete independent-account OAuth and paired D1/R2 backup/restore, verify file and receipt equality, and re-enroll devices against the restored deployment.
3. Install the exact assets on minimum Obsidian and physical iOS/Android. Exercise concurrent edits/deletes/renames, interruption, disable/re-enable, PWA install/update, logout and actual scheduled push.
4. Complete remote CI and Obsidian community review/scanner reproduction before tagging/publishing. Verify the live privacy page and OAuth callback.

**Should fix before release**

5. Enable branch/ruleset and secret protections plus dependency security updates (G03); read back effective settings. Keep private reporting enabled.
6. Measure hosted cold/warm 1k/10k workloads and document a tested support envelope (G02). Optimize only the demonstrated bottlenecks. If the intended initial workload fails, that result becomes a release blocker.

**Can safely follow after release**

7. Add randomized three-runtime schedules and a user-invoked integrity scan; improve redacted support export and backlog/receipt-growth diagnostics. Add contributor templates as needed. Do not reopen migration work or replace working state machines for aesthetic reasons.

## 16. Five highest-value improvements

| Priority | Next work | Completion evidence |
|---|---|---|
| 1 | Independent-account setup and disaster-recovery rehearsal | Paired archive verified; restored hashes/receipts match; new devices enroll |
| 2 | Minimum-host and physical iOS/Android validation | Exact candidate, recorded versions, lifecycle/conflict/push results |
| 3 | Repository branch and secret protections | Effective rules, enabled security statuses and required checks verified |
| 4 | Hosted capacity envelope | Cold/warm 1k/10k metrics, convergence and mobile latency, documented supported range |
| 5 | Final release rehearsal | Remote CI and Obsidian review/scanner pass; tag, version and artifact hashes agree |

The next engineering milestone should be a tested release candidate, with failures feeding back into focused fixes. Another broad refactor is not justified by the current findings.

## 17. Release-readiness score

| Category | Score / 100 | Main remaining factor |
|---|---:|---|
| Architecture | 90 | Aggregate work and future state-machine growth |
| Sync correctness | 90 | Physical multi-client and randomized histories |
| Data safety | 90 | Independent restore and actual process-kill evidence |
| Backend reliability | 90 | Hosted failure/capacity envelope |
| Obsidian plugin | 87 | Minimum-host and physical adapter behavior |
| PWA | 89 | Installed-device updates, permissions and push |
| Security | 88 | Hosted repository protection gap and bounded audit coverage |
| Testing | 92 | Strong regressions; remaining full-system execution environments |
| UI/UX | 85 | Physical accessibility and real conflict-recovery interaction |
| Open-source readiness | 78 | Candidate operational sign-off and source-admission controls |
| **Overall** | **89** | Rounded unweighted mean: 88.9 |

**Would I personally approve public release today? No.** The reproduced code defects are fixed, including the additional handoff issue found in the repeat analysis. The remaining sign-off work is proving this exact candidate on real accounts and devices, establishing its hosted envelope, and completing the repository/release checks above. No guarantee of universal correctness is implied by the passing local suite.
