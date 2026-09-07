# Crate pre-release engineering re-audit

Audited on 2026-09-06 against `2a564af` (`refactor: remove legacy compatibility and dead code`), version `0.1.0`, protocol 4, schema 1. This repeats the original comprehensive audit after the remediation and cleanup commits. Production code was not changed. The unrelated edits to `site/index.html` and `site/assets/site.css` were left untouched and are outside this assessment.

## 1. Executive summary

**Public-release recommendation: No, for this candidate.** The existing release gate passes, but new adversarial tests reproduce four functional defects: a local edit can become invisible to sync change detection, delayed projection can silently cancel a notification, duplicate reminder IDs can replace another file's notification ownership, and a fresh enrollment link fails to recover an expired browser session. A fifth, low-severity finding is documentation that still promises removed schema upgrades.

There are **two HIGH, two MEDIUM, and one LOW confirmed findings**. No new CRITICAL or BLOCKER-severity defect was established. The two HIGH findings are nevertheless release-stopping correctness problems. This is not a claim that ordinary sync overwrites arbitrary files: the local bytes in the checkpoint reproduction remain intact, and the guarded write paths continue to protect concurrent edits.

The current architecture is materially safer than the original audited version. Immutable R2 objects, conditional D1 commits, revision-aware deletes, guarded local writes, retained remote versions, durable reminder receipts, scoped browser sessions, notification projection fencing, and resumable paired recovery remain present. The cleanup correctly removed obsolete protocols, migrations, public scheduling routes, and redundant local notification plumbing. **The recommendation is to keep current-format-only support. None of the fixes below requires a legacy adapter.**

Fresh evidence:

| Check | Result |
|---|---|
| `npm run release:check` | Passed, exit 0 |
| Unit tests | 999 passed across 175 files |
| Local Cloudflare runtime integration | 51 passed across 8 files |
| Recovery tests | 17 passed |
| Chromium and WebKit browser suites | Cache, focus, editing, session cleanup and UI interaction checks passed |
| Visual regression | 48 passed |
| Visual TypeScript check | Passed |
| ESLint, plugin/Worker typechecks, both Knip passes, notices | Passed within the release gate |
| Production build, CSS scope, artifact validation, size budgets | Passed |
| `npm audit --json` | Zero reported vulnerabilities |
| Gitleaks history and current source | Passed; 436 commits scanned |
| New audit probes | Three failing assertions in unit/Worker tests; enrollment failure reproduced in both browsers |

The failing probes assert the desired safe behavior; their failures demonstrate the findings, rather than an unexplained test-environment failure. Sources and outputs are preserved in [audit evidence](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2a564af/README.md). Temporary executable probes were removed from `src/` and `scripts/` after execution.

Tests ran locally on Node 24.19.0. This audit did not deploy to Cloudflare, run the independent-account recovery rehearsal, install the candidate on physical iOS/Android devices, or reproduce the release across Node 20/22/24.0.0. Those remain explicit verification gaps, not passing claims.

## 2. Release blockers

Here “release blocker” means a condition that prevents sign-off, not the highest finding-severity label.

1. **A01: repair download/checkpoint consistency.** A same-length edit made after applying downloaded bytes can be marked clean indefinitely.
2. **A02: preserve notification eligibility across delayed projection.** A committed, forthcoming reminder must not disappear from delivery obligations simply because the coordinator runs late.
3. Fix **A03** and **A04** before presenting reminders and browser recovery as dependable public features.
4. Complete the repository's hosted, physical-device, minimum-Obsidian-version and paired-recovery checklist (**G01**). No completed candidate-specific record was found in the audited evidence.

There is no reason to reintroduce the removed direct scheduling API, old schema migrations, or permissive browser enrollment fallback to resolve these conditions.

## 3. Critical/high-priority findings

### A01 — Download acknowledgement can hide a concurrent local edit

**Severity:** HIGH. **Confidence:** Confirmed. **Category:** Confirmed bug. **Area:** Sync, checkpoint correctness, startup recovery.

**Problem and impact:** `recordDownloadedContent` computes the hash and size from the downloaded buffer, then obtains the current path's modification time. A local edit between those operations binds the old remote hash to the new local file's metadata. The incremental planner and periodic safety scan compare size and mtime before hashing; both then report no change. The user's newer local bytes survive, but other devices never receive them until another event or metadata change exposes the difference.

**Concrete sequence:** A file contains `base`. Startup sync applies remote `next`. Before checkpoint metadata is captured, the user changes it to `edit`, which has the same length. The checkpoint stores the hash of `next` with the mtime of `edit`. Startup event capture is disabled during this interval. The recovery scan reports clean; later metadata-based scans do the same. A restart after the checkpoint is saved also preserves the false clean state.

**Evidence:** The unit probe used the real download/apply and local-change planning functions with an in-memory vault. It recorded different checkpoint/actual hashes, `changes: []`, and `detected: false`. See [probe output](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2a564af/checkpoint-reproduction.log).

**Relevant code:** [download checkpoint](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/transfer-download.ts:68), [metadata candidate filter](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/planner-local.ts:38), [metadata safety scan](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/local-file-changes.ts:23), [startup event suspension and recovery](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/runtime.ts:124). Similar post-write metadata capture occurs in [conflict/merge application](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/transfer-process.ts:145); that related path was inspected but not separately reproduced.

**Root cause:** The acknowledged content and the metadata used to certify it come from different local versions. The metadata recovery scan assumes that pairing is trustworthy.

**Recommendation:** Capture and verify a stable local snapshot before recording its metadata as clean. If the current bytes no longer match the downloaded bytes, keep the remote baseline but leave the path explicitly dirty or its local metadata untrusted. Preserve event revisions across the apply/acknowledgement boundary. Apply the same invariant to batch downloads and merges; changing only the periodic timer would leave the false checkpoint intact.

**Proving tests:** Single and batch download, merged Markdown, same-length edit during checkpoint capture, startup events paused, restart from the persisted checkpoint, and a subsequent sync that uploads the newer edit. Assert the actual remote bytes, not only queue callbacks.

### A02 — Delayed first projection silently cancels a due notification

**Severity:** HIGH. **Confidence:** Confirmed. **Category:** Confirmed bug. **Area:** Reminder scheduling, durable recovery, observability.

**Problem and impact:** Projection schedules a reminder only if its deadline is still in the future, or the exact due time already exists in `scheduled_reminders` within the retry window. A first projection delayed past the deadline has no existing schedule, so it emits a successful `cancel`, removes the projection job and leaves no failed-delivery record. Durable queuing therefore does not preserve the delivery obligation through a coordinator delay.

**Concrete sequence:** At time T, commit a reminder due at T+60 seconds. Its immediate coordinator wakeup fails, or other projection work delays it. Process the job at T+120 seconds. The output is `operation: 'cancel'`. The configured fifteen-minute maintenance fallback makes delayed first processing an operationally relevant case.

**Evidence:** Reproduced with the actual schema, D1/R2 bindings and production projection function in the Cloudflare local runtime. The fake clock advanced only the projection's eligibility decision. See [notification probes](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2a564af/notification-reproductions.log).

**Relevant code:** [eligibility predicate](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-projection.ts:34), [job removal](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-projection.ts:71), [coordinator](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-coordinator.ts), [maintenance configuration](/Users/kaanbiryol/Documents/Projects/obsidian-crate/wrangler.jsonc).

**Root cause:** Eligibility is inferred from projection execution time and already-created alarm state, rather than durably recording when this occurrence became eligible for delivery.

**Recommendation:** Preserve occurrence eligibility through delayed projection and use an explicit, bounded late-delivery policy. Distinguish a forthcoming occurrence committed before its deadline from a newly imported historical reminder; do not indiscriminately send every overdue task. If a delivery is too late, expose a missed/expired outcome instead of recording a normal cancellation. Retain the existing completion receipts and source/policy fences.

**Proving tests:** Lost wakeup recovered by maintenance; queue delay crossing the deadline; a title edit while waiting; restart before first alarm publication; delays within and beyond the late-delivery window; initial import of old reminders; replay after successful delivery. Assert both delivery and diagnostics.

### A03 — Duplicate identities across files can replace notification ownership

**Severity:** MEDIUM. **Confidence:** Confirmed. **Category:** Confirmed bug. **Area:** Reminder identity, server projection, PWA consistency.

**Problem and impact:** Duplicate IDs are rejected within one projected file, but the D1 upserts replace an existing reminder's owner when the same ID appears in another file. A completed copy can cancel the original incomplete reminder's notification. The web list returns both records without an identity issue, despite downstream identity-based state expecting uniqueness.

**Concrete sequence:** Commit an incomplete future reminder to `Reminders/A.md`, then commit a completed copy carrying the same `crate-id` to `Reminders/B.md`. Project both. The sole projection now belongs to B and the original schedule command becomes `cancel`. Both list entries remain and `issues` is empty.

**Evidence:** The local Cloudflare runtime probe produced exactly that state; see the second case in [notification probe output](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2a564af/notification-reproductions.log).

**Relevant code:** [per-file duplicate check](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-projection.ts:37), [ownership-replacing upsert](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/notification-projection.ts:66), [combined web index](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/reminder-cache.ts), [plugin normalization](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/data/vaultScanner.ts:210).

**Root cause:** Global identity uniqueness is assumed by server state but enforced only by an independently running plugin scan. The plugin normalizes duplicate IDs during full and per-file scans, which reduces exposure. It does not make raw sync commits globally valid: reminders can be disabled on a sending device, and a copied file can reach the Worker before normalization.

**Recommendation:** Detect conflicting live owners at the authoritative server boundary and surface an actionable per-file identity issue. Do not let an ambiguous file overwrite another owner's outbox state. Preserve legitimate atomic moves by allowing ownership transfer once the prior committed source no longer contains the occurrence. Define the same identity behavior for the list and mutation paths.

**Proving tests:** Duplicate across two files in both processing orders; completed copy versus active original; simultaneous copies; normalization repair; legitimate project move; deletion of either duplicate. Confirm which original schedule survives and that the PWA never silently conflates records.

### A04 — A fresh link does not recover an expired stored browser session

**Severity:** MEDIUM. **Confidence:** Confirmed. **Category:** Confirmed bug. **Area:** PWA enrollment and recovery UX.

**Problem and impact:** Bootstrap exchanges a URL enrollment token only when there is no stored bearer token. URL cleanup has already removed the fresh enrollment parameters. With an expired stored token, the later API call returns 401 and clears the session; the fresh token is no longer available to that bootstrap attempt. The user follows the recovery instruction and lands back on the same instruction.

**Concrete sequence:** A browser contains an expired reminder session. Open a valid fresh `browserToken` link from Crate. Bootstrap skips exchange, cleans the address bar, attempts the expired session and signs out. Opening the original link a second time can work, but retrying the cleaned page cannot redeem it.

**Evidence:** Reproduced against the production PWA bundle in Chromium and WebKit. Both sent **zero** enrollment exchanges and displayed “Open a fresh link from Crate” after receiving that link. The preview's session script was overridden to seed the expired token; the preview API rejected it. See [browser output](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audit-evidence/2a564af/enrollment-reproduction.log).

**Relevant code:** [stored-token preference](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/hooks/usePwaBootstrap.ts:59), [URL token cleanup and configuration](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/config.ts), [401 handling](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/api.ts).

**Root cause:** Fresh enrollment is treated as initial setup only, even though the UI documents it as recovery. Configuration, authority and token redemption do not transition together.

**Recommendation:** Let an explicit fresh enrollment link recover or replace stale authority, or retain the fresh token in memory while validating the existing session and exchange after rejection. Keep tokens out of the address bar. On folder/authority changes, invalidate prior cache/draft state and coordinate other tabs. Preserve distinct browser and installed-app enrollment tokens.

**Proving tests:** Expired and revoked sessions; fresh browser and standalone links; existing valid same-folder session; changing enrolled folder; failed exchange; reload during exchange; second open tab. Assert the exchange count, final authority, visible folder and cleared sensitive state.

## 4. Sync correctness assessment

The main protocol is coherent: local hashes and acknowledged baselines feed a three-way planner; remote writes compare expected hashes; deletes also require the acknowledged opaque revision; downloaded bytes are verified before local application. R2 bytes are immutable, and metadata/changelog/derived-work intent commit together in D1. A file operation is not globally transactional across the local filesystem, HTTP, D1 and R2, so retries and reconciliation remain necessary.

| Scenario | Current assessment |
|---|---|
| Simultaneous edits from two devices | Conditional remote writes reject stale content; Markdown can merge against the stored base; conflicts preserve copies. |
| Delete versus edit | The changed side is preserved or reconciled; local remote-deletion application uses vault trash. |
| Delete retry after same-content recreation | Remote revision check protects the new incarnation; covered by integration tests. |
| Rename/move | Sync models filesystem paths, so ordinary renames are delete/create convergence, not a cross-device atomic rename. Destination checks and retained versions reduce loss risk. |
| Repeated upload or lost response | Same-content acknowledgement is verified; uncertain commits preserve objects for later reference-aware cleanup. |
| Partial batch failure | Per-path outcomes remain visible; incomplete operations do not advance the checkpoint as successful. |
| Truncated/stale change cursor | Cursor-expiry handling falls back to manifest reconciliation; pagination has progress guards. |
| Corrupt or missing remote bytes | Hash/size validation rejects application instead of certifying the data. |
| Local modification during remote download | Atomic text compare-and-write guards the write itself; **A01 remains after the write**. |
| Binary update or new hidden path | Conservative incoming-copy/review behavior avoids an unguarded overwrite; this is a documented functional limitation. |
| Oversized files | 25 MiB file and byte-aware transfer limits produce explicit errors. |
| Invalid local checkpoint/current format | Rejected/preserved for diagnosis; no silent legacy conversion. |

The main remaining correctness problem is certification of local state after a write, not the remote CAS transaction. A broader assumption remains that unchanged size/mtime means unchanged content. External tools that deliberately preserve both attributes can evade metadata-only discovery; a future explicit integrity scan would help, but that general limitation is separate from A01, which happens with ordinary changing mtimes.

## 5. Sync threat model

**Assets:** Local note bytes, remote immutable objects and retained versions, the mapping from path to current object, acknowledged baselines, reminder identities/receipts, credentials, and notification delivery obligations.

**Trust boundaries:** Obsidian vault adapter ↔ plugin runtime; plugin/PWA ↔ authenticated Worker; Worker ↔ D1/R2; D1 outbox ↔ Durable Object; Durable Object ↔ push provider; online session ↔ browser storage; live deployment ↔ recovery archive.

| Threat or failure | Protection observed | Remaining concern |
|---|---|---|
| Concurrent or stale device | Hash CAS, delete revision, semantic reminder revisions | A01 can falsely certify local state. |
| Network timeout after commit | Immutable staging, durable operation receipts, retry/reconcile | Completion/delete browser retries are less seamless than persisted editor saves; do not promise general offline mutation queuing. |
| Local crash or plugin unload | Durable checkpoint, runtime generations, abort and teardown | Exercise unload at every initialization await in real Obsidian; see G01. |
| Remote object loss/corruption | Hash verification, retained versions, paired backup | Retention is finite; independent backup remains necessary. |
| Delayed/stale background work | Source, policy and job-token fences; completion receipts | A02 loses first-delivery eligibility; A03 breaks owner uniqueness. |
| Malformed or malicious Markdown | Path validation, shared parser, safe text rendering, size limits | Duplicate IDs need authoritative handling. |
| Stolen browser token | Folder-scoped route allowlist, expiry/revocation | Authorized content is readable until revocation/expiry; no end-to-end vault encryption. |
| Unsafe push endpoint | Provider host validation, redirect rejection, deadlines, owner checks | Hosted delivery and device permission behavior remain unverified here. |
| Incomplete backup/restore | Hash-verified paired archive, target isolation, resumable checkpoints | Independent hosted restore rehearsal is still required. |

No unauthenticated vault-content read, arbitrary cross-folder reminder write, or remote-code execution was established in this pass. That is a bounded review result, not a formal security proof.

## 6. Architecture assessment

The high-level ownership is sensible: a seven-line bundle entry, a plugin lifecycle shell, separate sync planner/transfer/queue/checkpoint modules, shared reminder parsing and mutation semantics, a Worker persistence boundary, and separate host UI shells with shared reminder components. The cleanup removes competing authority paths: the Worker now derives notification work from committed Markdown.

The remaining complexity is concentrated at transitions between those modules. A01 crosses filesystem application and manifest certification; A02 crosses committed intent and wall-clock scheduling; A03 crosses file ownership and global identity; A04 crosses URL/configuration and session authority. These are good places for explicit contracts and adversarial tests.

Recommended ownership improvements are to centralize the verified local-apply acknowledgement, define durable occurrence eligibility in the notification domain, and make PWA enrollment one explicit session transition. Avoid a broad rewrite during release preparation. `engine.ts` is 487 lines, `pwa/main.tsx` 382 and `reminder-alarm.ts` 351; their size alone is not a defect, but further state transitions should have focused helpers and invariant tests.

Dead-code validation passed in both normal and production-entry configurations. That supports the cleanup; it does not prove every reachable option is useful. No additional obsolete feature was proven necessary to remove in this pass. Preserving open tabs' assets during a current-version deployment is active update behavior, not evidence of a legacy protocol adapter.

## 7. Cloudflare/backend assessment

**Persistence:** Uploads stage uniquely named R2 objects and publish references with conditional D1 transactions. Failed or uncertain commits do not immediately reclaim potentially referenced bytes. Deletes retain versions and record changelog/projection intent. Paired Markdown moves condition both sides before publishing their references and receipt. Cloudflare documents strong R2 read-after-write/list consistency; this supports immutable-object verification but does not turn R2 plus D1 into a cross-service transaction. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)

**Background work:** Projection and outbox drains are bounded; source/policy/job fences reject superseded commands. Alarm delivery serializes state changes, preserves recipient progress and completed occurrences, checks recipient authority, and records exhausted delivery failures. A02 and A03 still prevent end-to-end scheduling correctness. The coordinator's batching and maintenance fallback provide recovery opportunities, not a deadline guarantee.

**Maintenance:** Expired versions, queued objects, changelog, tokens and request-limit rows have explicit maintenance paths. Orphan sweeping advances a persisted cursor, examines at most 100 objects per run, and observes a 24-hour uncertainty window. Failures are recorded without aborting every later maintenance task. Large object sets can take many runs to sweep; report backlog age rather than assuming every orphan disappears after 24 hours.

**Schema and deployment:** The current schema marker and build-time artifacts are intentional. Provisioning rejects unsupported databases instead of converting them; server-version/protocol checks prevent casual downgrade. README descriptions must match that contract (A05).

**Capacity:** Per-file cache values are capped at 1.5 MiB and reminder source notes at 1 MiB; warm reads are bounded to 20 files/2 MiB. These are useful protections against D1's documented 2,000,000-byte row/value limit, but do not bound the aggregate list response or total parsed cache heap. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

## 8. Obsidian plugin assessment

The entry point stays small, configured sync has a lifecycle coordinator, secrets use the Obsidian API, settings and commands have explicit ownership, and mobile-incompatible binary overwrite assumptions are avoided. Runtime initialization revisions prevent superseded sync initialization from taking ownership, and shutdown destroys the runtime/deployment service and unregisters the reminder watcher.

Startup's event-suspension strategy relies on a metadata recovery pass, which is why A01 can become a silent steady state. The plugin also normalizes reminder IDs, but the server must remain safe when that optional client-side pass has not happened (A03).

There is a remaining lifecycle test gap: `bootstrapPlugin` spans several awaits, while its `activePlugins` membership primarily guards the final notification reconciliation. Unload during settings load or reminder-index creation needs a real-host test and a deferred-promise regression test proving that no watcher, timer or API client becomes active afterward. I have not established a user-triggerable leak in real Obsidian, so this is included in G01 rather than reported as another confirmed bug.

`minAppVersion` is 1.13.0 and `isDesktopOnly` is false. Local typechecks against the installed definitions do not establish compatibility with that minimum version or with mobile adapters. Physical-device installation, background/resume, and exact-artifact verification remain required.

## 9. PWA assessment

The PWA distinguishes live data from cached read-only state, guards stale responses with session/request generations, persists editor drafts and immutable pending save commands, and clears sensitive local state on logout across tabs. The service worker caches the application shell/assets; authenticated reminder content is handled by the explicit IndexedDB cache. Asset versioning preserves lazy chunks needed by open clients, and update activation is explicit.

A04 breaks the documented expired-session recovery path. A03 also exposes duplicate identities to the list. Neither requires restoring an old token format. The current cache format and separate browser/install tokens should remain strict.

Editor-save retry has stronger durability than completion/delete/reorder interaction state: the server receipts make exact retries safe, but those latter browser commands are not a durable offline queue. Tests should continue to verify response loss, stale revisions and user-visible recovery rather than treating all HTTP failures as an uncommitted operation.

Chromium/WebKit automation passed for cache lifecycle, focus, retained drafts, logout, text editing, paste/composition, viewport batching and pull-to-refresh layout. Installed-app behavior, real push delivery and mobile keyboard/accessibility behavior are outside the reach of those desktop browser runs.

## 10. Security assessment

The source review found explicit bearer authentication, hashed stored credentials, separate vault/reminder scope, exact folder restrictions and source-path checks, bounded request parsing, a protocol mutation gate, operation identity checks, known-provider push endpoints and owner validation at send time. Worker mutation diagnostics correlate request/session/operation IDs without embedding reminder bodies or vault paths. Production secrets scanning and the current dependency audit both passed.

The deployment uses bundled code with artifact hashes, OAuth state/PKCE, transient Cloudflare authorization and hashed permanent device credentials. Release actions are pinned by SHA and publication permissions are separated from the build job. There is no need to weaken these controls for the proposed fixes.

Residual exposure is explicit: a full vault credential authorizes the vault, the Cloudflare account/Worker can read synced contents, browser XSS would expose the scoped local session and cached content, and recovery archives are sensitive. The reviewed paths do not show a new exploit for those boundaries. A04 is an availability/recovery defect, not a demonstrated authentication bypass.

The current notification rate limiter uses D1 on unauthenticated notification mutations. It is not an edge-level defense against request floods consuming Worker/D1 resources. Capacity and abuse testing should measure that cost (G02); this audit does not label the mere presence of a public, metered endpoint a vulnerability.

## 11. Missing test matrix

“Covered” below means relevant automated evidence exists, not proof of every interleaving. “New failing” refers to this audit's preserved probes.

| Scenario | Evidence now | Required addition or release check |
|---|---|---|
| Two-device same-file edit | Planner/transfer and CAS tests | Full two-client convergence trace on exact artifacts |
| Delete versus edit | Automated coverage | Physical-vault trash recovery |
| Delete replay after identical recreation | Worker integration | Retain in gate |
| Rename into occupied/case-colliding path | Path/planner protections | Cross-platform rename storm and restart |
| Apply succeeds, local edit precedes checkpoint | **New failing A01** | Single/batch/merge and persisted restart variants |
| Startup edit while events suspended | Metadata recovery coverage | A01 content-certification assertion |
| Lost R2/D1 commit acknowledgement | Worker integration | Retain fault-injection cases |
| Partial upload/download batch failure | Automated coverage | Mixed binary/Markdown multi-client run |
| Cursor expiration and manifest pagination | Automated coverage | Concurrent writers during large manifest traversal |
| Invalid checkpoint and recovery archive | Automated coverage | Physical adapter interrupted checkpoint writes |
| First projection delayed across deadline | **New failing A02** | Maintenance fallback and explicit lateness policy |
| Cross-file duplicate reminder identity | **New failing A03** | Both orders, repair and legitimate moves |
| Stale notification source/policy/outbox | Worker integration | Retain token-fencing cases |
| Delivery replay and partial recipient failure | Worker integration | Hosted provider acknowledgement uncertainty |
| Recurrence count/end-date/timezone/DST | Unit/shared-core coverage | Cross-device spring/fall transitions and all-day policy |
| Ambiguous editor save after local draft changes | Unit/browser coverage | Hosted response-loss replay |
| Expired session plus fresh enrollment link | **New failing A04**, both browsers | Browser/standalone, new folder, second tab |
| Logout with pending reads/writes and open tabs | Browser/unit coverage | Installed-app and actual subscription revocation |
| Old open tab across a current deployment | Service-worker lifecycle tests | Two real installed client versions during rollout |
| Disable/re-enable during initialization awaits | Incomplete | Deferred settings/index/network operations; no post-unload side effects |
| 1,000 / 10,000 notes | No end-to-end benchmark produced | CPU, memory, request/row counts, convergence and UI latency |
| Real iOS/Android notifications and keyboard | Not run here | Physical device matrix |
| Independent-account OAuth and paired restore | Not run here | Signed candidate checklist and retained artifact hashes |
| Node 20/22/24 reproducibility | Workflow configured | Successful candidate CI outputs; local run used 24.19.0 only |

### G01 — Hosted and physical-device release evidence remains incomplete

**Severity:** HIGH. **Confidence:** Confirmed as an evidence gap. **Category:** Missing protection/test. **Area:** Release validation and operations.

**Why it matters:** The plugin claims mobile support, integrates account-scoped OAuth, deploys several Cloudflare resources and relies on actual browser push providers. Passing local emulation can coexist with a hosted permission, API, minimum-version or installed-app failure.

**Scenario:** An unrelated account provisions the candidate or a physical iPhone installs it for the first time; permissions, enrollment, background delivery or recovery differ from local fixtures. No such failure was demonstrated, but this audit cannot sign off those paths.

**Root cause/location:** The necessary manual gates exist in [release checklist](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/release-checklist.md), but no completed record for this candidate is in the audited evidence. The [recovery runbook](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/recovery.md) also explicitly requires the independent-account rehearsal.

**Recommendation/proving evidence:** Complete that checklist on the fixed candidate, record device/Obsidian versions and artifact hashes, and attach hosted OAuth, scheduled push, disable/re-enable and paired-restore outcomes. A completed external record can close the evidence gap without changing production code.

## 12. UI/UX assessment

The shared visual suite passed 48 combinations across plugin/PWA, dark/light, 390/1280 widths and representative card/editor/date/project/recurrence screens. Browser tests verify focus, text entry, undo/redo, paste/composition and layout behavior. Cached read-only state, oversized-note issues, sync errors and retained drafts are useful user-facing safeguards.

A01 can produce misleading clean sync status, A02 can disappear without a delivery failure, A03 presents duplicate identities without an issue, and A04 gives a recovery instruction that just failed. These are more important for release than additional visual polish. Their fixes should produce clear state transitions and short actionable messages.

Visual snapshots are not an accessibility audit. Screen-reader navigation, high zoom, touch targets, physical keyboard dismissal, reduced motion and installed-app permission prompts still need manual review. No new contrast or screen-reader defect was confirmed in this pass.

## 13. Performance/scalability assessment

Transfer preparation and request batches enforce byte budgets, downloads use bounded concurrency, queue retries avoid unbounded hot loops, and reminder cache warm-up limits source reads. The UI interaction suite demonstrates efficient node reuse and viewport handling; it is not a 10,000-note benchmark.

The metadata/index/list path still materializes whole-folder metadata and cached reminder arrays. At the maximum 20 fresh files per warm-up request, 1,000 initially uncached reminder files need at least 50 requests; 10,000 need at least 500. Each request again loads whole-folder metadata and accumulated cache data. These are code-derived lower bounds assuming the 2 MiB limit does not further reduce the batch, not measured user latency. Ordinary notes outside the reminders folder do not all participate in this reminder-index cost.

Cloudflare currently documents 128 MB per Worker isolate and 10 ms HTTP CPU on Workers Free. Passing Miniflare tests does not establish either hosted budget at scale. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

### G02 — Aggregate list/startup capacity is not demonstrated at the target sizes

**Severity:** MEDIUM. **Confidence:** High for the architectural risk; runtime exhaustion is unproven. **Category:** Architectural risk / missing test. **Area:** Scalability and release capacity.

**Scenario and impact:** Cold-start a folder with thousands of small reminder files, or refresh a large combined index while several clients sync. Repeated whole-folder reads, parsing, response serialization and plugin discovery can dominate CPU/memory/latency despite per-request source-byte limits. Users may see prolonged warm-up or hosted resource errors.

**Root cause/location:** Bounded source fetching is combined with unbounded aggregate materialization in [list route](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/routes/list.ts), [cache loader](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/reminder-cache/load.ts), [cache aggregation](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/reminders-web/reminder-cache.ts), and full local discovery in [file discovery](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/file-discovery.ts).

**Recommendation/proving tests:** Benchmark 1k/10k notes with declared file sizes, reminder density, device counts, cold/warm caches and network conditions. Record p50/p95 startup, convergence, list/edit latency, D1 rows/queries, CPU and peak memory. If budgets fail, paginate aggregate results, avoid loading every cached body merely to warm the next batch, or publish an honest supported capacity/plan requirement. Do not infer production timings from these static estimates.

Bundle checks pass but some budgets have little room: PWA startup assets are 129.62 KiB gzip against 129.88 KiB; plugin CSS is 135.38 KiB raw against 136.72 KiB. Plugin JS is 1,330.96 KiB raw / 737.43 KiB gzip, Worker 1,207.90 / 553.09 KiB, and PWA app JS 105.33 / 34.73 KiB. These are repository budgets, not Cloudflare's platform limits.

## 14. Open-source readiness

The repository includes a license, security policy, version/manifest metadata, privacy/network disclosures, architecture/protocol/recovery documentation, third-party notices, reproducible-build checks and a controlled release workflow. Generated release assets remain outside tracked source. Release tags must exactly match the manifest version, and publication refuses to overwrite an already published release.

### A05 — README still advertises removed schema upgrades

**Severity:** LOW. **Confidence:** Confirmed. **Category:** Confirmed documentation defect. **Area:** Setup and current-format contract.

**Problem/sequence:** A user reads the deployment/privacy description before reconnecting an unsupported database. It says ordered schema upgrades are bundled, while the implementation and architecture document intentionally reject unsupported schemas and bundle no upgrade scripts. This creates the wrong recovery/update expectation.

**Relevant code/docs:** [README disclosure](/Users/kaanbiryol/Documents/Projects/obsidian-crate/README.md:44), [README deployment explanation](/Users/kaanbiryol/Documents/Projects/obsidian-crate/README.md:120), [current architecture contract](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/architecture.md).

**Root cause:** User-facing prose was not fully updated during removal of the migration machinery.

**Recommendation:** Replace both references with the current schema-initialization/validation contract and link to supported recovery. Do not restore upgrade code to satisfy the old prose.

**Proving check:** Review both sentences against schema provisioning and recovery behavior, then search active setup/release documentation for the removed promise. A production test is unnecessary for this prose edit.

Historical audit reports mention obsolete code because they document earlier candidates; those are not active compatibility features. Source-search matches such as Cloudflare's older permission-label wording should be judged by meaning rather than deleted mechanically.

The configured GitHub private-reporting link, deployed privacy page and community review scan were not independently certified in this pass. They remain checklist items, not assumed failures.

## 15. Recommended release plan

**Must fix before public release:** A01 and A02 with the failing probes converted into permanent regressions; A03 identity ownership/list behavior; A04 fresh-link recovery; A05 contract wording. Review the final diffs for accidental weakening of CAS, source/policy fences or current-format validation.

**Must verify before sign-off:** Re-run the complete release gate on that exact commit, visual/security checks and Node-version reproducibility. Complete G01 with exact release artifacts. Repeat the narrow adversarial analysis around each fix rather than relying solely on increasing the passing test count.

**Should do before broader rollout:** Establish G02 capacity measurements and an initial supported envelope. Record notification backlog age, missed/expired occurrences, terminal deliveries, sync errors and recovery outcomes without note content. Add the initialization/unload interleavings and real upgrade-with-open-tabs scenario to candidate testing.

**After a stable release:** Consider an explicit content-integrity scan, measured improvements to aggregate reminder pagination, and focused extraction of state-transition helpers. Keep cleanup opportunistic and evidence-based; do not reintroduce deleted compatibility code or start a release-time rewrite.

Disposition of the previous eight findings: the reviewed fixes remain present for trash-based local deletion, logout revocation dispatch, stale notification fencing, completed-occurrence replay suppression, ambiguous editor saves, recipient authority, terminal-delivery diagnostics and resumable paired restore. Their automated tests pass in this candidate. This audit did not reproduce a regression of those exact scenarios; A01–A04 expose additional boundaries.

## 16. Five highest-value improvements

1. Make local clean-checkpoint certification depend on the exact verified bytes and metadata of one local version (A01).
2. Persist notification occurrence eligibility and expose explicit late/missed outcomes (A02).
3. Enforce reminder identity ownership consistently across committed files, projection and web lists (A03).
4. Treat a fresh enrollment link as an explicit session recovery transition, including multi-tab state (A04).
5. Produce exact-candidate hosted/mobile/recovery and 1k/10k capacity evidence (G01/G02).

## 17. Engineering score and verdict

The scores are engineering judgments about this candidate and its evidence, not probabilities of correctness. Equal weighting gives a rounded **80/100**.

| Category | Score / 100 | Main constraint |
|---|---:|---|
| Architecture/maintainability | 85 | Good boundaries; cross-module state contracts need tightening |
| Sync correctness | 74 | Confirmed false-clean checkpoint race |
| Data safety/recovery | 82 | Strong preservation and paired tooling; hosted rehearsal absent |
| Backend/reminder delivery | 77 | Delayed first projection and duplicate ownership |
| Obsidian lifecycle/mobile | 80 | Minimum-version/physical-device and unload evidence incomplete |
| PWA correctness | 78 | Fresh enrollment recovery fails with stored expired authority |
| Security/privacy | 88 | Strong scoped controls and clean scans; bounded review only |
| Automated testing/build | 86 | Broad passing suite; new boundary probes still fail |
| UI/UX/accessibility | 83 | Visual/interaction coverage; failure-state and manual accessibility gaps |
| Operations/scalability/release evidence | 69 | No hosted capacity or completed independent-account/device sign-off |

**Can this candidate be released publicly? No.** Fix the confirmed correctness/recovery issues and complete the required candidate validation. The codebase is substantially improved, but a green existing test suite does not override the new reproducible failures.
