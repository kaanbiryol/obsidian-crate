# Crate pre-release engineering audit — d66e0fa

Date: 2026-09-06. Candidate: `d66e0fa2059b0b439f7455bb57fe47f1ba64575f` on `master`, version 0.1.0, protocol 5, D1 schema 2. This is a fresh review after fixing the five findings in the previous audit. Unrelated pending changes to `site/index.html` and `site/assets/site.css` are outside this candidate. No production source was changed during this second analysis; temporary executable probes were removed.

## 1. Executive summary

The five previously confirmed findings are fixed and committed. Download and merge checkpoints now verify local bytes before certifying modification times; delayed notifications retain their original occurrence observation; duplicate reminder identities are quarantined with actionable issues; fresh enrollment links replace stale browser sessions; documentation describes current formats without promising removed upgrades.

The repeat audit found **two MEDIUM defects**: enrollment can consume its one-time token before a failing session transaction, and plugin bootstrap can continue after shutdown during settings loading. The latter is reproduced at the lifecycle boundary with controlled promises; its availability through actual Obsidian UI actions still needs a host test. No new BLOCKER, CRITICAL or HIGH-severity code defect, vault-byte loss, cross-folder exposure, or remote-code execution was established.

One HIGH verification gap remains: the exact candidate still needs independent-account OAuth/recovery, minimum-version Obsidian and physical iOS/Android sign-off. Aggregate workload capacity remains a MEDIUM architectural risk. This audit adds successful local warm-list probes at 1,000 and 10,000 files, but does not establish hosted CPU, memory, cold-start or full-sync limits.

**Engineering score: 86/100. Public release approval today: No**, pending the candidate-specific operational/device checks. The two medium defects should also be corrected while completing those checks. The reason for withholding approval is not a claim that the passing sync paths are unsafe: the strongest previous correctness failures now have regression coverage.

| Verification | Candidate result |
|---|---|
| Post-commit `npm run release:check` | Passed, exit 0 |
| Clean-checkout `release:check` on Node 24.0.0 | Passed, exit 0, with the same unit/Worker/recovery/browser results |
| Unit suite | 1,003 passed, 176 files |
| Local Cloudflare runtime suite | 63 passed, 10 files |
| Recovery suite | 17 passed, including preservation of source and occurrence records |
| Chromium and WebKit | Cache, focus, editing, layout interaction, drafts, logout and fresh-session recovery passed |
| Visual regression / visual typecheck | 48 passed / passed |
| ESLint, plugin/Worker TypeScript, both Knip passes, notices | Passed |
| Build, CSS scope, bundle budgets, release artifacts | Passed without increasing budgets |
| npm advisory audit | Zero reported vulnerabilities |
| Secret scan | Gitleaks 8.30.1 passed; 437 commits and current source scanned |
| Clean install / exact Node-version builds | Passed; Node 20.19.0, 22.12.0 and 24.0.0 produced identical artifacts |
| Additional audit probes | Two new failing safety assertions; both warm-list completeness probes passed |

The release suite ran on Node 24.19.0 and again in a clean checkout on the repository's Node 24.0.0. Artifact hashes, commands, logs, temporary probe sources and capacity data are indexed in [the evidence record](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2026-09-06-source-integrity/README.md). Failing safety probes are reported separately from the passing committed suite. Diagnostic errors used to capture timing output are not product failures.

The clean release-matrix builds agree with each other. Their `main.js` differs from the local Node 24.19.0 output solely in the gzip bytes embedding the Worker: the decompressed Worker hash and all remaining plugin bytes are identical. Use [the release-matrix hashes](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2026-09-06-source-integrity/release-matrix-artifacts.json) when performing the candidate checklist; do not substitute the local patch-version hash. This is a reproducibility boundary between runtime versions, not a new code defect or a failed comparison between the three required CI versions.

## 2. Release blockers

No newly confirmed code defect meets the audit's BLOCKER or CRITICAL definition. Sign-off is nevertheless withheld until **G01** has a completed candidate record: clean-vault install on Obsidian 1.13.0, independent-account OAuth, paired D1/R2 restore into isolated resources, and physical mobile sync/push/lifecycle testing. Existing templates and earlier candidate evidence do not demonstrate those outcomes for this build.

The format change must be respected during testing and release: this candidate accepts **protocol 5 and schema 2 only**. Existing schema-1 deployments are rejected before Worker upload. Keep those resources and original vaults intact; use separate current resources for this prerelease. Do not connect the new Worker to an unsupported database. This is the intentionally documented current-format-only contract, not a request to restore migrations or compatibility features.

## 3. Critical/high-priority findings

There are no newly confirmed CRITICAL/HIGH code findings. The following are the actionable medium defects discovered in the repeat analysis.

### R01 — A failed session transaction burns a valid enrollment link

**Severity:** MEDIUM. **Confidence:** Confirmed. **Classification:** Confirmed bug. **Area:** Backend transaction integrity, PWA recovery.

**Problem:** `handleExchangeRemindersEnrollmentToken` consumes the token through a separate `DELETE ... RETURNING` before the batch that creates the new session and revokes the previous reminder credential. If that batch fails before committing, the enrollment token is already gone and no new session exists.

**Why it matters:** A temporary database error forces the user back to Obsidian for another link. The normal expired-session recovery fixed in this commit works; the remaining failure is at the backend transaction boundary. No vault data is lost, and the previous session is not revoked by the failing batch.

**Concrete sequence:** Issue a valid, unexpired link. Exchange it. Let the token deletion succeed, then inject a database outage before session creation commits. Retry the same link after the database recovers. The probe records `remainingTokens: 0`, `sessions: 0`, `retryStatus: 401` instead of a successful exchange.

**Relevant code:** [token deletion](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/web-enrollment.ts:43), [exchange ordering](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-enrollment-handlers.ts:44), [session transaction](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-enrollment-handlers.ts:56). Evidence: [failure injection](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2026-09-06-source-integrity/capacity-and-enrollment.log).

**Root cause:** One logical exchange spans two independently committed database operations.

**Recommended change:** Put eligibility-checked consumption, session insertion and optional previous-session revocation in one guarded D1 transaction. Preserve the one-time-use and folder-scope rules. Define the separate response-loss case explicitly; atomicity alone does not make a committed exchange safely replayable after its response disappears.

**Proving tests:** Failure before the transaction, failure inside each statement, retry after rollback, two simultaneous exchanges, expiry at the boundary, and loss of the response after commit. Assert session/token/subscription rows and ensure a retry cannot widen authority or mint multiple sessions.

### R02 — Bootstrap can reactivate services after shutdown

**Severity:** MEDIUM. **Confidence:** Confirmed at the lifecycle boundary; real-host trigger not yet verified. **Classification:** Confirmed lifecycle bug with a host verification gap. **Area:** Obsidian startup/unload, resource ownership.

**Problem:** `bootstrapPlugin` waits for core initialization before inserting the plugin into `activePlugins`. `shutdownPlugin` removes the membership and destroys only services that exist at that moment. If settings are still loading, the later continuation creates services, adds active membership, registers handlers and initializes sync after shutdown.

**Why it matters:** An initialization/shutdown overlap can leave activity owned by a disabled or replaced plugin instance. Repeated reloads could produce stale handlers or an extra sync runtime. The probe establishes continuation and initialization calls, not observed network traffic or a real Obsidian leak.

**Concrete sequence:** Begin bootstrap with a deferred `loadSettings()`. Call shutdown before it resolves. Resolve settings. Production bootstrap then calls manager creation once, sync initialization once, vault-event registration once and protocol registration twice; the newly created runtime receives zero destroy calls. The desired assertion that initialization never runs fails.

**Relevant code:** [bootstrap activation](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/plugin/lifecycle.ts:26), [shutdown](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/plugin/lifecycle.ts:44), [post-settings service creation](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/plugin/lifecycle.ts:57). The related reminder-index await precedes watcher creation in [setupReminderBackend](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/runtime.ts:15); that await was inspected, not separately reproduced. Evidence: [lifecycle probe](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2026-09-06-source-integrity/lifecycle-probe.log).

**Root cause:** Cancellation is represented only by current active membership, established too late. It does not identify or invalidate the bootstrap attempt across all awaited initialization boundaries. SyncRuntime's own revision checks protect an already-running initialization, but cannot prevent a new call to initialize after destruction.

**Recommended change:** Establish a lifecycle generation at bootstrap entry, invalidate it at shutdown and check it after settings, managed-connection restoration, reminder-index loading and sync initialization. Ensure any resource constructed during a stale attempt is immediately disposed. Keep this state in lifecycle/runtime ownership instead of adding a generic service framework.

**Proving tests:** Deferred settings, connection restoration, index load and sync initialization; shutdown at each await; a second plugin instance starting before the first settles; assertions on live watchers, timers and API requests. Repeat disable/re-enable in actual supported Obsidian versions.

## 4. Sync correctness assessment

Sync compares current local content, the acknowledged local baseline and remote state. Events feed a coalescing path queue; periodic and foreground checks recover missed events. Incremental change pages fall back to paginated manifest reconciliation when cursors expire. Writes stage immutable R2 content before a conditional D1 metadata/changelog/retention/projection commit. Deletes require both hash and opaque incarnation revision. Downloads verify content before applying it; guarded local text updates preserve competing edits. Markdown merge uses the retained common base.

The repaired checkpoint adds a necessary final invariant: **a baseline hash may use local metadata as a clean certificate only when a stable read verifies that exact content**. If the file changed, disappeared or became unreadable, the remote baseline is kept with untrusted metadata, forcing future hashing. Regression tests cover single download, batch download and merge, persistence/restart, and a subsequent upload of the newer local edit.

| Distributed scenario | Observed behavior and practical limit |
|---|---|
| A and B edit one note offline | CAS rejects the stale writer; Markdown can merge; conflict preservation retains competing bytes. Classification/model and transfer tests pass. |
| A edits, B deletes; reverse order | Changed content is reconciled rather than silently accepting a stale delete. Local removal uses vault trash. This can retain/recreate a path intentionally to preserve an edit. |
| A renames, B edits old path | Ordinary sync treats rename as delete/create. Both the new path and edited old path may remain; content preservation takes precedence over inferring rename intent. |
| A and B rename differently | Both destination paths can survive. There is no cross-device atomic filesystem rename guarantee. A full two-host trace is still needed. |
| Delete, then identical recreation, then old delete retry | Revision precondition prevents the old delete from removing the new incarnation; runtime integration passes. |
| PWA stale form after plugin edit | Semantic reminder revision plus file CAS rejects stale whole-form edits. |
| Response lost after file commit | Committed objects remain referenced; verified identical retries succeed. Ambiguous staged objects are retained for reference-aware cleanup. |
| Partial batch or interrupted initial/force upload | Per-path outcomes remain visible; failed uploads prevent the destructive remote-delete phase of force sync. |
| Crash while saving checkpoint | Serialized writes and generations recover the newest valid main/temp checkpoint. Corrupt unsupported state is preserved and rejected. |
| Long offline interval | Expired changelog cursors trigger full reconciliation. Retained remote versions are finite, not permanent backup. |
| Changed bytes on download | Size/hash validation rejects corrupt remote content. Unsafe binary replacement produces a review copy. |
| Same length local edit after remote apply | Fixed: persisted restart tests detect and upload the edit. |

The metadata optimization still assumes external tools do not change bytes while deliberately preserving both size and mtime. An explicit integrity scan would be a useful optional diagnostic. No new silent-loss sequence was established from that general assumption in this pass. Three-device exhaustive schedules and physical filesystem crash tests remain incomplete.

## 5. Sync threat model

Protected assets include vault bytes, immutable/retained objects, path-to-object references, checkpoints, reminder identities and delivery receipts, credentials and local browser drafts. Trust boundaries are the Obsidian adapter, authenticated HTTP, D1/R2, D1-to-Durable-Object projection, push services and browser persistence.

| Threat/failure | Protection found | Remaining exposure |
|---|---|---|
| Stale client overwrites a newer note | Content CAS, revision-aware delete, guarded local writes, common-base merge | Real multi-host event ordering remains part of G01. |
| Incorrect deletion or loss of conflict bytes | Local trash, conflict/review copies, 30-day remote versions | Permanent independent backup is still needed. |
| D1/R2 partial failure | Immutable staging, guarded references, uncertainty-preserving cleanup | No cross-service transaction; operational reconciliation remains essential. |
| Corrupted checkpoint or object | Generation recovery, format validation, content verification | Corrupt records may require explicit recovery; integrity scans are not universal. |
| Duplicate/out-of-order mutation | File preconditions, reminder operation receipts and request hashes | Enrollment exchange is the separate R01 exception. |
| Duplicate reminder ID | Current source ownership index, quarantine, list issues, mutation rejection | User/plugin must repair ambiguous Markdown before derived behavior resumes. |
| Delayed/stale notification command | Original occurrence observation, policy/source/job fences, durable completion receipt | External push acknowledgement uncertainty cannot guarantee exactly-once human-visible notification. |
| Plugin disabled during startup | Runtime abort/generation checks and teardown | Bootstrap itself has R02. |
| Stolen web session | Folder-bound route allowlist, expiry, revocation, owned push subscriptions | Bearer grants that folder until revoked/expired; local device compromise is outside this boundary. |
| Malicious push destination | HTTPS/provider allowlist, redirect rejection, deadline | Actual provider/device behavior needs G01. |
| Mixed or incomplete restore | Paired archive hashes, isolated empty target, resumable import checkpoint | Hosted independent-account rehearsal still absent. |

Vault data is not end-to-end encrypted against the owning Cloudflare account. Push payload encryption protects content from the provider while delivery metadata remains visible. These are disclosed trust decisions, not newly discovered defects.

## 6. Architecture assessment

Responsibility boundaries are generally effective: the entry shell is seven lines; plugin lifecycle/settings, sync planning/transfers/checkpoints, Worker storage/routes/projection, shared reminder domain logic and PWA host state are separate. Shared parsing and semantic revisions reduce plugin/PWA disagreement. The new applied-content helper consolidates an actual repeated correctness boundary rather than introducing an ornamental abstraction.

R2 is the byte store, D1 the authoritative reference/receipt/source store, and Durable Objects serialize delivery state. The folder-scoped PWA edits authoritative Markdown through server commands rather than maintaining an independent productivity database. No KV, queue service or WebSocket layer is required by the inspected implementation.

The practical architectural weaknesses are lifecycle ownership across awaits (R02), transaction ownership across enrollment helpers (R01), and whole-folder materialization (G02). Keep those concerns local: lifecycle generation in plugin/reminder initialization; guarded exchange in the enrollment module; paginated aggregate indexing only after measurement defines a required envelope. Retain existing storage CAS, shared reconciliation and shared reminder parsing.

Large orchestrators remain (`engine.ts` 487 lines, PWA main 384, alarm 354), but length alone is not a release defect. If changed substantially, extract alarm delivery retry/receipt transitions together, keeping their token guards with them; do not scatter state-machine invariants across generic utilities. Module-level settings/session generations and weak maps have explicit runtime purposes; no new dead production module or obsolete feature was confirmed. Both Knip passes are clean, without claiming static analysis proves every dynamic path is useful.

## 7. Cloudflare/backend assessment

The selected primitives fit a personal-vault deployment. Immutable R2 objects avoid replacement races. File metadata, changelog, retention and projection intent share D1 transactions; pair writes guard both Markdown files together. R2's documented strong consistency supports verified read-after-write, but does not supply atomicity with D1. [R2 consistency documentation](https://developers.cloudflare.com/r2/reference/consistency/).

Source ownership and first-observation records now commit alongside file metadata. Projection can be delayed without reclassifying a previously forthcoming occurrence as historical. Legitimately late delivery is bounded at 24 hours and exposes a failed-delivery diagnostic beyond that window; newly imported historical occurrences are cancelled. Duplicate owners leave an actionable projection error and block stale alarm delivery until repair. Tests cover both path orders, deletion repair, title changes, moves and renames.

The protocol's upload limit is now three files and delete limit four, reserving room for authentication and cleanup after additional source-integrity statements. Byte limits and bound-parameter limits remain separate guardrails. Cloudflare currently documents 50 D1 queries per Free invocation, 100 parameters per query, a 2,000,000-byte value/row limit and 30-second query duration. Passing the query budget does not establish hosted CPU capacity. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Maintenance runs every fifteen minutes, handles cleanup/retention/token expiry and recovers missed coordinator wakeups. Work is bounded per pass and failures are recorded. Source, policy and schedule tokens guard stale jobs; completion and recipient progress survive retries. R01 is the specific remaining transaction defect. Whole-folder reads and accumulating operation/occurrence records require capacity monitoring; no artificial retention policy should delete receipts that still protect retries.

## 8. Obsidian plugin assessment

The plugin keeps network transfer separate from connection consent, uses secret storage for sync authority, and delegates heavy work outside the entry shell. Reminders are initialized when enabled. Sync startup pauses event acceptance then reconciles; runtime teardown clears timers and aborts work. R02 shows the outer bootstrap can still bypass that lifecycle intent.

Filesystem operations use vault interfaces, including guarded text writes, trash for remote deletes and preserved binary incoming copies. Path portability checks reject case/Unicode collisions; hidden-file discovery filters ignored paths and uses iterative walks. This protects broader vault coverage at the cost of extra adapter traversal. Exact behavior under iOS/Android adapter latency and external changes must be tested on devices.

The manifest advertises Obsidian 1.13.0 and mobile support. Compiling against Obsidian types is not proof of those host behaviors. Candidate tests must include slow index initialization, unload/re-enable, rename/delete races, binary review-copy resolution, mobile background/resume and supported minimum APIs.

## 9. PWA assessment

The PWA has a cached static shell, an IndexedDB reminder snapshot, metadata-only revalidation, local editor drafts and request/session generations. Failed editor saves retain drafts through reload; retries resolve the original attempt before newer draft changes are sent. Mutation receipts protect recurrence advancement and deletion replay. It should not be presented as a general offline queue for every possible action.

Fresh enrollment now deliberately overrides stored authority, removes URL tokens, revokes the replaced reminder session's push registration, clears old cache/drafts and coordinates folder replacement across tabs. Chromium/WebKit regressions cover browser versus installed-app token choice, failed exchange, expired stored token and another open tab. R01 concerns a deeper server failure after consumption, not the original bootstrap bug.

Service-worker activation is explicit; old shells/chunks remain while active clients need them, and unknown client versions conservatively delay collection. That protects open clients and is not an old-protocol adapter. Version 5 mutation checks fence incompatible tabs. Installed-app update transitions, blocked storage deletion, browser eviction, subscription renewal and actual mobile permission flows still need device evidence.

## 10. Security assessment

No new authority escalation, cross-folder access, arbitrary external push destination, injected code execution or committed secret was confirmed. Authentication hashes bearer credentials, rejects unknown scopes and fails closed on database errors. Reminder authority is restricted by route and exact enrolled folder; push endpoints and subscription ownership are checked separately. Protocol rejection precedes mutation. Existing security integration cases passed against this candidate.

Deployment bundles Worker/schema artifacts at build time and verifies hashes before use. OAuth uses state/PKCE and does not persist the temporary exchange material. There is no fetched-code execution or hidden telemetry identified. R01 is reliability rather than an authority bypass: failed session creation does not grant extra scope.

The advisory scan reports zero known vulnerabilities, not proof of dependency safety. The lockfile, third-party notices, SHA-pinned GitHub Actions, separated publication permissions and checksum-pinned secret scanner are useful supply-chain controls. Security-sensitive code still depends on crypto, parsing and push libraries and deserves review when dependencies change. A clean install emitted npm lifecycle-script approval notices for native/build tooling; builds are the meaningful check that required tooling is available.

For a report that a note disappeared, preserve the affected vault/checkpoint before resets; correlate request/session/operation IDs and opaque object revisions with retained versions and sync history. Mutation logging omits note content and filenames. Diagnostics expose maintenance state, pending/failed projections, outbox/delivery failures and retained versions. A user-controlled redacted support export and backlog-age metrics would reduce investigation friction without collecting telemetry. Private vulnerability-reporting availability must still be confirmed in the hosted repository settings.

## 11. Missing test matrix

“Component” means automated coverage exists for relevant behavior; it does not assert a full Obsidian-to-hosted-Cloudflare device test. New probes are preserved separately from the committed suite.

| Required scenario | Evidence now | Remaining proof |
|---|---|---|
| A edits / B edits | Reconciliation model, merge/transfer and CAS components pass | Real two-client convergence and conflict-copy review |
| A edits / B deletes | Both-order model and remote-delete components pass | Physical trash recovery under concurrent edits |
| A deletes / B edits | Same protection, reversed-order tests pass | Real filesystem event order |
| A renames / B edits | Path reconciliation model retains both outcomes | Two devices plus interruption |
| A renames / B renames | Individual rename/path guards | Complete competing-rename multi-client run |
| Delete / recreate | Same-content revision replay integration passes | Cross-platform repeat |
| Three-device concurrency | Pairwise boundaries covered | Three real runtimes with randomized schedules |
| Plugin / PWA concurrency | Stale semantic update and atomic move integration pass | Full UI-to-plugin round trip |
| Weeks offline | Expired cursor and full-manifest fallback components | Large history with active writers |
| Network failure before request | Retry/queue/auth error components | Hosted connection transitions |
| Network failure during transfer | Abort, partial-batch and verified-download components | Physical background interruption |
| Failure after server commit | R2/D1 uncertain-commit and reminder-receipt integration pass | Hosted lost-response trace |
| Duplicate requests | Same-content writes, recurrence and delete receipts pass | Concurrent enrollment exchange after R01 fix |
| Out-of-order requests | CAS, source/policy/job fences pass | Randomized mixed-operation schedule |
| Client crash during apply/checkpoint | Main/temp recovery and new single/batch/merge restart tests pass | Kill actual Obsidian during disk operations |
| Backend failure during sync | Real local D1/R2 fault injection passes | Hosted operational rehearsal |
| Corrupt local persistence | Checkpoint rejection/recovery tests pass | Physical adapter error injection |
| Migration failure | No migration feature exists | Current-schema retry and unsupported schema rejection already covered |
| Old client / new backend | Protocol 2/3/4/6 and missing header reject; current 5 passes | Open installed client during rollout |
| Multiple PWA tabs | Logout and fresh-folder replacement in Chromium/WebKit pass | Installed/browser combination |
| Service-worker version mismatch | Lifecycle/activation components pass | Two deployed asset versions with open tabs |
| Delayed notification projection | New observation, title/move/rename and 24-hour tests pass | Real lost wakeup and cron recovery |
| Duplicate reminder identity | Both orders, issues, blocked edits and repair pass | Concurrent plugin normalization on devices |
| Failed enrollment transaction | **R01 reproduced** | Atomic rollback and concurrency regressions |
| Unload during settings load | **R02 reproduced** with deferred promise | Other awaits and actual host invocation |
| 1,000 / 10,000 files | Warm-list completeness, uniqueness and 304 probes pass | Cold index, full sync, hosted CPU/memory and mobile UI |
| Independent account / physical push | Not performed | G01 candidate checklist |

### G01 — Candidate-specific host, account and device evidence is incomplete

**Severity:** HIGH. **Confidence:** Confirmed evidence gap. **Classification:** Missing protection/test. **Area:** Release validation, recovery and mobile reliability.

**Problem/impact:** No completed record proves that these exact artifacts can enroll an unrelated Cloudflare account, restore a paired archive into another account, work on minimum Obsidian or deliver installed-app push on physical iOS/Android. Local mocks and browser engines cannot verify account entitlements, OAuth registration, host adapters or operating-system suspension.

**Concrete scenario:** The unit/build gate passes, but a new user's independent account or mobile host rejects setup or fails to resume. This is a scenario to test, not a reproduced failure.

**Relevant files/root cause:** [release checklist](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/release-checklist.md), [recovery runbook](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/recovery.md), deployment service, plugin lifecycle and push integration. The verification boundary extends beyond this local audit environment.

**Recommended change/proving tests:** Complete and retain the checklist against the recorded artifact hashes, using non-critical data and isolated resources. Include independent-account enrollment, initial upload, a restore with matching file hashes/receipts, re-enrollment, actual scheduled push, exact minimum host version, and background/disable/re-enable. No hosted failure is asserted here.

## 12. UI/UX assessment

The implementation has explicit sync activity, conflict/review copies, partial-failure errors, confirmation for force overwrite and remote-only deletion, cache/offline status, retained draft errors and actionable session renewal. The new identity issues name affected files; late-delivery failures reach diagnostics instead of silently appearing as ordinary cancellation.

The 48 visual cases and both browser interaction suites passed. Focus, editing history, composition, paste, node reuse and viewport batching have useful coverage. This does not certify VoiceOver/TalkBack, physical keyboard overlays, OS notification prompts, all Obsidian themes or touch behavior on actual devices.

R01 adds unnecessary recovery friction after a transient backend error. R02 undermines the expected meaning of disabling the plugin. Binary review copies and rename-related duplicate paths are intentional preservation outcomes; users need clear conflict/activity context when resolving them. No additional actionable visual-design defect was established in the unchanged shared UI.

## 13. Performance/scalability assessment

Local warm-list probes used one valid, unique reminder per Markdown file and production parsing to construct a matching warm cache. They checked the full returned count, unique identities, no issues and correct conditional 304 behavior. D1 queries were counted at the handler boundary, excluding HTTP authentication. Five samples were recorded per size.

| Files / reminders | 200 response bytes | Median local 200 wall time | 200 D1 queries | Median local 304 wall time | 304 D1 queries |
|---|---:|---:|---:|---:|---:|
| 1,000 | 286,930 | 15 ms | 3 | 3 ms | 1 |
| 10,000 | 2,878,930 | 123 ms | 3 | 18 ms | 1 |

Warm response ranges were 12–23 ms and 120–151 ms respectively. These measurements include local D1 work, parsing/serialization and reading the response body. They exclude hosted network/CPU limits, R2 transfer, cold cache construction, initial plugin upload, mobile memory and browser rendering. They are evidence of successful bounded fixtures, not a 10,000-note hosted support guarantee.

### G02 — Whole-folder work and long-lived records need an operational envelope

**Severity:** MEDIUM. **Confidence:** High. **Classification:** Architectural risk. **Area:** Backend/PWA aggregate capacity and operating cost.

**Problem:** Every list loads all folder metadata; a warm 200 also loads/parses all cached records and computes each reminder revision. Even 304 computes a folder-wide revision. Cold warming handles at most 20 files and 2 MiB per request while repeatedly loading folder metadata/cache. The new occurrence table joins existing durable operation/identity records whose growth has no proven long-term envelope.

**Why it matters/concrete scenario:** A 10,000-file cold folder needs at least 500 list attempts, potentially more for larger notes, while whole-folder work repeats. Multiple devices amplify reads and serialization. A large vault with many directories also makes periodic hidden-file discovery expensive. This is not a demonstrated hosted exhaustion or an observed out-of-memory failure.

**Relevant code/root cause:** [list handler](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/routes/list.ts), [cache aggregation](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/reminder-cache.ts), [cache loader](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/reminder-cache/load.ts), [vault discovery](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/file-discovery.ts), [source observations](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-projection-queue.ts). Per-file bounds do not bound aggregate work.

**Recommended change:** Measure hosted cold/warm lists, initial/incremental sync and multi-device workloads; publish a tested initial envelope. If it fails the intended workload, maintain a folder revision and paginate/index aggregate results, while retaining semantic-revision and source guards. Define safe archival/compaction semantics before deleting long-lived retry/occurrence records.

**Proving tests:** 1k/10k mixed notes, thousands of reminders in fewer large files, deep folder trees, weeks of changes, multiple clients and injected latency. Record CPU, heap, D1 rows/queries, R2 requests, index progress, time to convergence and UI response. Cloudflare's documented Free HTTP CPU budget is 10 ms and isolate memory is 128 MB; local wall time cannot be substituted for either. [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

Production size gates pass, but PWA startup gzip is 129.73 KiB against a 129.88 KiB budget; app gzip is 34.84 against 35.16 KiB. This narrow headroom is a maintenance constraint. Plugin main is 1,332.18 KiB raw / 738.36 KiB gzip; Worker is 1,210.54 / 553.84 KiB. No budget was loosened to accept the fixes.

## 14. Open-source readiness

README, architecture/protocol/API/deployment/recovery/testing guides, AGENTS instructions, security policy, 0BSD licensing and generated notices give contributors a useful starting point. Release automation validates exact tag/version, builds on three exact Node versions, compares artifacts, attests outputs and separates publishing authority from build jobs. The fixed README no longer promises ordered schema upgrades.

Current-format rejection is now consistent across provisioning, protocol mutation checks and recovery schema validation. The version-2 occurrence/ownership data is preserved by paired restore while derived state and credentials are reset. Do not add schema migrations or historical adapters merely to increase an audit score.

A dedicated contribution guide, issue templates and a code of conduct could help after initial release but are optional community improvements, not technical blockers. The required immediate evidence is a completed candidate checklist, hosted private-reporting availability, actual public deployment/privacy/OAuth behavior and independent recovery. Local passing builds do not prove those hosted settings.

## 15. Recommended release plan

**Must complete before public sign-off:** G01 with exact artifact hashes, independent accounts and physical devices; verify the minimum Obsidian version and community review/build checks. Preserve unsupported deployments and use separate current resources. Record any deployment limitations explicitly.

**Should fix before release:** R01 transactional exchange and R02 lifecycle cancellation, with their concrete failure-injection regressions. Establish G02's initial hosted envelope, particularly cold indexing and mobile memory. Repeat the relevant artifact and safety gates after code changes.

**Can follow after release:** Broader randomized multi-replica schedules, an explicit content-integrity scan, a redacted support export, backlog-age/receipt-growth diagnostics and contributor templates. Refactor large coordinators only where upcoming changes expose real ownership problems.

## 16. Five highest-value improvements

1. Make enrollment consumption and replacement-session creation atomic, preserving single-use authority through rollback.
2. Make every plugin initialization stage cancellable across shutdown and overlapping reloads.
3. Complete independent-account OAuth and paired restore against the candidate, including re-enrollment and verified file/receipt equality.
4. Complete physical iOS/Android and minimum-version Obsidian sync, background/resume, install/update and scheduled push tests.
5. Measure hosted cold/warm 1k/10k workloads and publish an initial supported envelope; optimize aggregate indexing only where measurements require it.

## 17. Release-readiness score

| Category | Score / 100 | Main factor |
|---|---:|---|
| Architecture | 88 | Focused ownership and shared domain logic; lifecycle/transaction boundaries remain |
| Sync correctness | 90 | Checkpoint race fixed; CAS, incarnation revisions and preservation remain strong |
| Data safety | 90 | Verified bytes, recovery generations, retained versions and paired tools; hosted rehearsal absent |
| Backend reliability | 86 | Durable source/occurrence projection repaired; enrollment transaction and capacity gaps |
| Obsidian plugin | 79 | R02 and minimum-host/physical-adapter evidence |
| PWA | 86 | Fresh-session and cross-tab recovery repaired; R01 and installed-device evidence |
| Security | 89 | Scoped authority, pinned tooling and clean scans; bounded review and hosted checks |
| Testing | 90 | Broad passing gates, restart regressions and adversarial probes; full host matrix incomplete |
| UI/UX | 85 | Strong interaction/visual coverage; physical accessibility and failure recovery remain |
| Open-source/operational readiness | 77 | Documentation and build process are sound; candidate operational sign-off incomplete |
| **Overall** | **86** | Unweighted mean of the categories above |

**Would I personally approve public release today? No.** I would first obtain G01's evidence and fix the two small, reproduced boundary defects. The previous audit's two high-severity correctness bugs are resolved; this verdict should not be read as carrying those findings forward. No legacy format, migration engine or removed feature is needed to finish the remaining work.
