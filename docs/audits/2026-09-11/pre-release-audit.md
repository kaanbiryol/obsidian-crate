# Crate pre-release engineering audit — 11 September 2026

## 1. Executive summary

**Recommendation: No — do not publish an installable release from this candidate yet. Readiness: 82/100.**

Crate has a substantially stronger safety foundation than a typical first release. Its implementation includes immutable R2 objects, conditional D1 commits, durable upload journals and receipts, revision-aware deletion, conservative Markdown merging, guarded Obsidian writes, reminder source verification, a durable PWA mutation outbox, and recovery tooling. These are implemented and exercised by tests; they are not merely architectural aspirations.

The remaining problems occur where one subsystem does not inherit another subsystem's guarantees:

- **F01:** Restoring a retained file bypasses the durable operation identity used for ordinary uploads. A replay can resurrect a file another device subsequently deleted.
- **F02:** Unauthenticated requests can consume the shared daily notification quota and deny legitimate enrollment and subscription operations.
- **F03:** A valid remote folder-to-file replacement can leave another device retrying indefinitely against its leftover local directory.
- **F04:** Candidate-specific hosted, minimum-Obsidian, and physical-device acceptance remains unverified in the evidence available to this audit.
- Additional confirmed behavior includes logout aborting on a browser-storage exception and the PWA disabling pinch zoom. Browser eviction, verification progress across restarts, and future protocol rollouts need explicit treatment.

I found **no demonstrated cross-tenant exposure, arbitrary code execution, silent loss of an ordinary concurrent Markdown edit, or unrecoverable remote-content corruption** in the examined paths. This is a bounded engineering assessment, not a proof that those failures are impossible.

**Scope and evidence.** Reviewed local commit **21bb9b8** (version **0.1.0**, protocol **7**, D1 schema **5**) together with the pre-existing edits to the PWA authentication-recovery and safety test scripts. Those edits were preserved. Production source was not changed. Temporary reproductions were removed from the source tree and retained as text artifacts beside this report.

| Verification performed | Result |
| --- | --- |
| Required Node runtime | Node 26.8.2; the shell's default Node 23 was not used for the authoritative checks |
| Repository check script | Passed lint, both TypeScript targets, full/production dead-code checks, notices check |
| Python recovery tests | 24 passed |
| Unit tests | 1,697 passed in 227 files |
| Local Workers integration tests | 302 passed in 41 files, using actual workerd/D1/R2/DO bindings |
| PWA behavior suite | All 27 scripts passed; Chromium and WebKit coverage as implemented by each script |
| Production build, PWA smoke, CSS scope, size budgets, release artifacts | Passed |
| Security gate | npm advisory audit: zero reported vulnerabilities, including development dependencies; Gitleaks: no findings in 720 commits or current source |
| New Worker reproductions | Three passed, asserting the undesirable behavior in F01–F03 |
| New browser reproduction | Logout failure reproduced in both Chromium and WebKit |
| Visual typecheck | Passed |
| Separate visual suite | **28 passed, 24 failed**; all failing cases are date/weekly/monthly scenes; inspected diffs show native 12/24-hour input rendering differences |
| Hosted Cloudflare, actual Obsidian, physical iOS/Android | Not executed in this audit |

The existing development watcher briefly replaced the shared build output during candidate recording. Final production artifact validation was therefore performed in an isolated checkout of the same commit with the two existing test edits. The watcher was left running. The initial candidate-recording failure was an audit-environment race, not evidence of a release-script defect.

Repository metadata read through gh reports that the repository is **already public**, with secret scanning and push protection enabled. An exact-SHA Actions lookup found the audited commit’s [build](https://github.com/kaanbiryol/obsidian-crate/actions/runs/34601889172) and [visual checks](https://github.com/kaanbiryol/obsidian-crate/actions/runs/34601889217) still in progress and its secret scan successful at inspection time. Retrieved failing runs on other commits are not attributed to this candidate. This recommendation concerns the installable release and its operational promises.

## 2. Release blockers

**No finding is assigned BLOCKER or CRITICAL severity.** The reproduced restore defect is serious, but it does not bypass the live-content hash precondition or erase all recovery copies. The notification issue affects notification management, not every sync endpoint. Severity should reflect those limits.

Nevertheless, I would hold the release for these concrete reasons:

| Gate | Required exit condition |
| --- | --- |
| F01 — restore replay | Stable restore intent and receipt survive lost responses; retry cannot apply the restore again after a later delete/edit |
| F02 — notification availability | Invalid credentials cannot spend the quota reserved for legitimate notification operations |
| F03 — directory replacement | Supported path transitions converge, or produce an actionable preserved-content state that users can resolve without guessing |
| F04 — acceptance evidence | Record exact-asset minimum-Obsidian, desktop/mobile, hosted OAuth/push/limits, and paired-backup restore results |

A passing local test suite cannot substitute for the last gate. The repository already documents these acceptance requirements correctly; this audit did not receive evidence that they have been completed for these artifacts.

## 3. Critical/high-priority findings

### F01 — Retained-file restore can execute twice after an ambiguous commit

- **Severity:** HIGH
- **Classification / confidence:** Confirmed bug / Confirmed
- **Area:** Recovery API, sync retry contract, Obsidian recovery UI
- **Problem:** Restore accepts a retained storage key and expected hash, but has no durable operation ID or receipt. Its error handler explicitly suggests retrying even when the database may already have committed.
- **Why it matters:** Recovery is precisely when users are likely to retry after uncertain results. A later deletion can be undone by replaying the earlier recovery intent.
- **Concrete sequence:** (1) A deleted note H has a retained version. (2) A restores H with expected absence. (3) D1 commits, but the caller receives 503 after a lost database response. (4) B observes the restored incarnation and deletes it using its current hash and revision. (5) A's identical restore request is retried. The expected-absence precondition is true again, so H is recreated. The reproduction observes changelog actions **put → delete → put**.
- **Files / symbols:** [handleRestoreFileVersion](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/file-version-handlers.ts:25), [SyncRuntime.restoreRecentFileVersion](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/runtime.ts:52), [restoreFileVersion](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/worker-api/sync.ts:267), [recovery modal](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/ui/remote-recovery-modal.ts:82).
- **Root cause:** Content preconditions describe current state; they do not identify a logical operation across an absent → present → absent cycle. Restore is outside the upload-journal/receipt path.
- **Recommended change:** Give restore a persisted client intent and server receipt, bound to the retained version, destination and original precondition. Commit the receipt with the metadata mutation. Replay returns the recorded outcome without restoring again. Distinguish “remote restore committed; local sync incomplete” from “restore did not happen” in the modal.
- **Proving tests:** Lost response after commit followed by delete, edit, and identical-byte recreation; concurrent duplicate restores; restart before/after receipt persistence; changed input under the same operation ID; expired receipt behavior. In the reproduced sequence, the final note must remain absent.

The repro uses the actual Worker route and local D1/R2, with failure injected after the real D1 batch commits. It does not claim that routine uploads have the same defect: their receipt path already prevents this replay.

### F02 — Anonymous requests can exhaust the notification-management budget

- **Severity:** HIGH
- **Classification / confidence:** Confirmed bug / Confirmed
- **Area:** Public API abuse protection and availability
- **Problem:** The fixed daily counter is charged before authentication and before the per-IP action limit. Invalid-token requests, including requests later rejected by the smaller action budget, spend the same 1,000-attempt allowance used by legitimate clients.
- **Why it matters:** Anyone who knows the Worker URL can deny enrollment, subscribe/unsubscribe and test-notification requests until the next UTC day.
- **Concrete sequence:** An attacker sends admitted notification mutation requests with invalid credentials. Each spends the daily budget. After exhaustion, the owner's valid enrollment request gets 429. The reproduction seeds the counter at 999, proves an invalid request returns 401 while incrementing to 1,000, and proves a valid enrollment request is then rejected.
- **Files / symbols:** [request dispatch](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/index.ts:49), [limitNotificationRequest](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/rate-limit.ts:17), especially daily-counter mutation at line 37.
- **Root cause:** A cost-control quota is also a globally shared authorization-independent availability gate. The edge limiter slows abuse but does not reserve capacity for valid callers.
- **Recommended change:** Retain cheap edge rejection, separate anonymous exchange attempts from authenticated actions, and charge authenticated quotas only after validating authority. Reserve legitimate management capacity. Design limits for both database-cost protection and user availability; simply removing all limits would lose the cost protection.
- **Proving tests:** Sustained invalid credentials across IPs/locations must not consume authenticated capacity; rejected per-IP attempts must not charge a valid-user allowance; valid unsubscribe/enrollment remains possible; legitimate overuse is bounded; midnight rollover and Retry-After remain correct.

**Impact boundary:** Existing scheduled deliveries and ordinary file synchronization are not directly stopped by this notification counter. Broader Worker/D1 quota exhaustion is a separate platform-capacity risk.

### F03 — A leftover local directory blocks a valid remote replacement file

- **Severity:** HIGH
- **Classification / confidence:** Confirmed bug / Confirmed in the integration harness; physical Obsidian confirmation remains desirable
- **Area:** Local filesystem application, path topology, convergence
- **Problem:** Remote namespace checks allow a directory subtree to be removed and its parent path reused as a file. The receiving client removes files but leaves the directory. Local snapshot reading treats any existing adapter path as readable file content.
- **Why it matters:** The remote state is valid, yet ordinary retries cannot apply it. The affected path remains divergent and sync reports failure.
- **Concrete sequence:** A and B contain **Projects/note.md**. A deletes that remote child and uploads a file named **Projects**. B trashes the removed child, leaving the directory **Projects**. Each attempt to download the replacement calls readBinary on that directory. It throws; the directory survives. The reproduction runs three sync attempts and observes the same failure while the remote file remains live.
- **Files / symbols:** [applyRemoteContentIfUnchanged](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/local-apply.ts:38), [readLocalSnapshot](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/local-apply.ts:94), [ensureParentFolder](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/local-apply.ts:114), [download application](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/transfer-download.ts:1).
- **Root cause:** The server models a portable file namespace; local application does not model directory-to-file transitions explicitly.
- **Recommended change:** Handle local path type explicitly. Safely remove or trash an empty obstructing directory only after checking excluded, hidden and newly created children. Preserve the incoming file and explain the obstruction when safe replacement cannot be established. Never recursively remove a directory based only on remote absence.
- **Proving tests:** Folder → file and file → folder, nested transitions, case variants, ignored/hidden children, a concurrent local child creation, permission errors, restart between child deletion and parent replacement, and repeat-sync convergence on real Obsidian adapters.

### F04 — Exact-candidate hosted and physical-device acceptance is not established

- **Severity:** HIGH
- **Classification / confidence:** Missing protection/test / High
- **Area:** Release acceptance, mobile compatibility, deployment and disaster recovery
- **Problem:** Local tests simulate the Obsidian surface, browser device identity, push transport and external API responses. The generated candidate record explicitly leaves seven acceptance fields unverified.
- **Why it matters:** Local workerd does not establish hosted CPU/query limits; desktop WebKit does not establish installed iOS behavior; mocked Vault APIs do not establish actual minimum-version or mobile filesystem semantics.
- **Concrete failure scenario:** Publish the tested JavaScript, then discover that an independent account cannot authorize the OAuth client, a physical mobile adapter violates a filesystem assumption, or a large hosted request reaches a free-tier limit. The local gate can stay green throughout.
- **Files / symbols:** [acceptance requirements](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/testing.md:1), [candidate record generator](/Users/kaanbiryol/Documents/Projects/obsidian-crate/scripts/release-candidate.mjs:1), [release workflow](/Users/kaanbiryol/Documents/Projects/obsidian-crate/.github/workflows/release.yml:1), [recovery procedure](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/recovery.md:1).
- **Root cause:** These are external-state acceptance checks; code tests and a generated checksum record cannot complete them automatically.
- **Recommended change:** Complete the documented matrix against the exact release hashes and retain the record privately. Include minimum Obsidian 1.13.0, an independent Cloudflare account, both physical mobile platforms, installed PWA push, hosted large-file/list measurements, and paired D1/R2 restoration into isolated resources.
- **Proving tests:** Evidence must identify candidate hashes, app/OS versions, account independence, resource limits, failure outcomes and restore byte/reference verification. A fresh successful CI run must use the final candidate commit.

This is missing evidence in this audit, not a claim that nobody has ever tested those environments.

## 4. Sync correctness assessment

**Actual lifecycle.** The plugin entry point delegates to its lifecycle and SyncRuntime. SyncEngine serializes workflows and coordinates local discovery, the last acknowledged manifest, a Markdown base cache, pending uploads, conflict state, and a remote sequence checkpoint. It recovers uncertain uploads before constructing a new reconciliation plan.

Bootstrap and full reconciliation enumerate remote metadata using bounded keyset pages. A snapshot sequence plus subsequent changelog overlay covers mutations that occur during pagination. Incremental synchronization consumes ordered change records; an expired or regressed cursor causes full reconciliation. Local mtime/size are acceleration hints, supplemented by content hashing and rotating verification.

Outgoing bytes are journaled before dispatch. The Worker stages a fresh immutable R2 object, then conditionally commits the live file row, changelog and relevant mutation state in D1. Successful/rejected upload receipts bind the exact intent and prevent a delayed duplicate from becoming a new mutation. Acknowledged local state is checkpointed before journal cleanup.

Incoming text is checked again in the Obsidian process callback after asynchronous hashing/download work. A changed preimage defers application. Unsupported existing binary writes preserve incoming bytes as review copies. Deletions compare acknowledged content and opaque revision remotely; local remote-deletion application uses trash.

| Invariant | Enforcement and practical limit |
| --- | --- |
| Published metadata must point to the intended bytes | Fresh immutable object keys, upload/download hash and size validation, and validation of retained versions; corruption produces errors rather than treating an unreadable file as deleted |
| A stale writer must not overwrite different current remote bytes | Conditional D1 content-hash updates; no timestamp last-writer-wins |
| A delayed delete must not delete a recreated identical-byte file | Hash **and opaque incarnation revision**, plus deletion receipts |
| An ambiguous upload must not execute again after later edits | Persisted exact local intent and D1 receipt; **restore is the F01 exception** |
| Remote commit is not proof of local merge application | Merge journal preserves the local preimage as a virtual ancestor; local application and checkpoint phases are separate |
| A rename source must survive until its destination is preserved | Durable rename dependencies and deletion barriers after upload/reconciliation failures |
| A local edit during download must survive | Atomic text comparison and preservation/defer behavior; binaries require review because there is no safe binary CAS in the chosen host API |
| A failed partial pass must not certify full convergence | Errors/deferred application retain work and prevent a successful full checkpoint; this can cause repeated work until the obstruction is resolved |
| Reminder mutations must not trust stale browser state | Semantic revision checks plus current Markdown parsing and file CAS; server-side multi-file moves use conditional D1 batching |
| Derived reminders must not outrank Markdown | Source revision/ownership checks, parser versioning and quarantine; notification projections are recoverable derived state |

**Concrete multi-client outcomes:**

| Scenario | Current behavior |
| --- | --- |
| A and B edit a note offline | Three-way merge when a trustworthy ancestor exists and the edits are compatible; preserve conflict content when merge is unsafe or the ancestor is absent |
| A edits while B deletes | A changed local version is preserved/resurrected as an edit/delete conflict outcome; if A's edit reaches the server first, B's stale revision deletion fails |
| A renames while B edits | The renamed copy and edited original can both remain. File identity is path-based; there is no automatic rewrite of every cross-note reference |
| A and B rename differently | Both destinations may survive. This is conservative content preservation, not a single globally selected rename |
| A deletes while B recreates the same bytes | Recreation has a fresh revision; A's old delete cannot consume it |
| Three devices edit related notes | Per-file convergence and conflict preservation; there is no general transaction across an arbitrary collection of notes or links |
| PWA edits stale state after plugin changes | Semantic mismatch rejects the command and retains the PWA draft; unrelated Markdown changes can be preserved by re-reading and applying the validated mutation |
| Request commits but response disappears | Ordinary uploads, deletes and reminder commands have replay protection; F01 shows the missing restore boundary |
| Operations arrive out of order | Content/revision preconditions and operation receipts reject or settle stale operations; the server does not assume arrival order equals intent order |
| Client crashes during local apply | Pending journal/checkpoint/base-cache recovery re-evaluates the state. A remotely committed merge is not blindly treated as already applied locally |
| Client returns after weeks offline | Changelog retention may force a full comparison; ancestor and local bytes still determine conflicts. Normal weeks-offline use does not by itself expire the 180-date operation window |
| Client returns after the receipt window | Expired unresolved operations are stopped for preservation/comparison. Plugin recovery is manual; resetting metadata is not an automatic safe retry |
| Remote directory becomes a file | F03: a leftover local directory can prevent convergence |

Tombstones are represented by the change history and absence relative to the client's acknowledged base, with separate deletion-incarnation receipts. The 30-day changelog window is not the only protection for an older client: full reconciliation handles expiration. Receipt retention and content-version retention have different purposes and durations.

The main gaps are topology transitions, restore intent identity, and acceptance on real filesystem adapters. A wholesale rewrite to CRDTs, a global Durable Object for all files, or timestamp arbitration would not be a justified response to these findings.

## 5. Sync threat model

| Dangerous outcome | Current protection | Residual exposure |
| --- | --- | --- |
| Newer remote bytes overwritten by a stale normal upload | Hash CAS, immutable staging, exact receipts | Authorized restore intentionally replaces content; its retries need F01 |
| Local Obsidian edit overwritten after download began | Atomic text preimage check; defer/preserve on mismatch | Actual adapters/other-plugin interleavings require F04; unsafe binary updates are deferred for review |
| Offline edit silently discarded during merge recovery | Durable payload/preimage, base verification, conflict copies | Browser eviction can remove the only uncommitted PWA copy; F06 |
| Permanent incorrect remote deletion | Revision-aware deletion, stale-delete rejection, 30-day retained content | Retention is finite and not an independent backup |
| Deleted content resurrected | Ordinary upload receipts and revision-aware deletion | **Confirmed F01**; edit/delete resurrection is otherwise an intentional edit-preservation rule |
| File duplication | Content-addressed review copies deduplicate unchanged incoming data | Different concurrent renames and unresolved binary changes can intentionally produce multiple copies |
| Duplicate reminder application | Stable IDs, semantic revision, operation receipts, identity constraints | Damaged/duplicate source markers are quarantined; no global arbitrary-note transaction |
| PWA/plugin disagreement | Markdown authority, shared domain logic, indexed-source revisions | Derived lists can lag during warming/projection; unsupported sources are explicitly reported |
| Metadata corruption with apparently valid content | Hash checks, schema/checkpoint validation, recovery generations | Manual repair must keep matching metadata and bytes together; metadata resets can destroy recovery context |
| Permanent sync failure/divergence | Reconciliation fallback, bounded retries and visible errors | **Confirmed F03**; expired/corrupt unresolved journals deliberately stop for recovery |
| Orphan cleanup removes a live blob | Immutable keys, reference-aware cleanup, grace/retention windows | Hosted failure injection and isolated backup restore still need F04 |
| Duplicate or missed notification | Durable scheduling/recipient progress, source and occurrence checks, bounded retries | Push-provider acceptance and local receipt storage are not one transaction; a crash in that gap can duplicate delivery, and OS/provider behavior can miss it |
| Malicious external read or mutation | Bearer authentication, folder scopes, path validation | A stolen valid device bearer has its granted authority; vault data is not end-to-end encrypted from the Cloudflare account |
| Anonymous service denial | Edge and database notification limits | **Confirmed F02**; ordinary authenticated routes also need hosted abuse/cost monitoring |
| Unrecoverable loss after retention or account deletion | Independent paired D1/R2 backups and local vault backups | A sync replica, retained versions and D1 alone are not sufficient independent backups |

For a “Crate deleted a note” report, first preserve the vault, local manifest generations, Markdown bases and pending-upload journal. Correlate the request/operation/session IDs and revision with Worker mutation logs and deletion receipts. Compare retained bytes and all device versions before resetting sync. Exported public diagnostics intentionally omit paths and note bodies; private local evidence is needed to identify the actual file.

## 6. Architecture assessment

The responsibility split is appropriate: Obsidian owns its filesystem integration; the Worker owns authenticated conditional mutations; D1 owns published metadata, identities and durable receipts; R2 owns immutable bytes; Durable Objects own notification scheduling; the PWA owns browser persistence and presentation. Markdown remains the shared domain source of truth.

The boundaries are generally useful rather than ceremonial. Sync workflows consume narrow context interfaces; reminder parsing/mutation/date rules are shared; the small plugin entry delegates lifecycle work. Searching production sources did not surface a material cluster of TODO workarounds, explicit any types or ignored type errors, and both dead-code checks pass. The extensive test harnesses are more permissive than the host filesystem, however, which is directly relevant to F03.

The most valuable structural change is to make **all intent-bearing file mutations**, including restore, use the same durable mutation contract. Keep transaction preparation, publication, receipt lookup, local application and recovery distinct. Do not force pure reads or disposable caches into that abstraction.

Other practical boundaries:

- A deployment is intentionally one vault in one owner's Cloudflare account. It is not a multi-user SaaS database missing tenant columns. Any future shared deployment requires an explicit tenant model across every file, receipt, reminder, object and subscription.
- General file renames are create/delete operations. Semantic reminder moves have stronger domain-specific coordination. Extending arbitrary multi-note transactions would be a product decision, not a cleanup task.
- Per-runtime queues, lifecycle cancellation and namespaced secret/checkpoint storage contain most hidden state. Module-level UI stores and configuration helpers warrant care during future multi-vault/live-preview reuse, but no cross-vault leakage was demonstrated.
- One D1 database is a throughput and availability boundary, appropriate for a personal vault. Notification coordination is recoverable from durable database state.
- The publisher's static OAuth callback domain is a connection/update dependency. Existing device tokens do not require the callback on every sync.

### F10 — The current protocol fences stale writers but has no released rolling-upgrade window yet

- **Severity:** MEDIUM
- **Classification / confidence:** Architectural risk / High
- **Area:** API evolution and mixed client versions
- **Problem:** Both current and oldest-compatible are 7. The range mechanism exists, but only the current prerelease write format is supported.
- **Why it matters / scenario:** After a future incompatible backend release, a phone or long-lived PWA on the older protocol must stop writing. Repeatedly raising both ends together would make every breaking release a coordinated client upgrade.
- **Files / symbols:** [CRATE_PLUGIN_PROTOCOL](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/protocol.ts:19), [protocol contract](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/protocol.md:1), [compatibility integration tests](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/protocol-compatibility.integration.ts:1).
- **Root cause:** A deliberate prerelease compatibility policy has not yet been extended to multiple supported public versions.
- **Recommended change:** Before protocol 8, define an additive compatibility window, capability negotiation rules and deprecation process. Support version 7 while old mutations can be interpreted safely; preserve read/export access when rejecting writes. Do not accept old commands whose safety preconditions are missing.
- **Proving tests:** Execute actual prior plugin/PWA bundles against the next server, and current bundles against the supported previous server. Include unknown additive fields, pending operations during upgrade, old service workers and receipt lookup after upgrade.

This is not a defect merely because a dangerous old prerelease writer is rejected. The rejection is the correct safety behavior today.

## 7. Cloudflare/backend assessment

**The selected primitives fit the workload.** There is no KV-based correctness dependency, general queue service or WebSocket synchronization layer to assess. Workers serve HTTP and maintenance; D1 is the mutation authority; R2 stores file bytes; reminder Durable Objects serialize scheduling and delivery state; cron provides recovery/progress.

R2 reads/writes/deletes/listing are strongly consistent through the binding. Immutable fresh keys therefore provide a sound basis for staging and publication. They do not create a transaction with D1. Crate correctly treats an uncertain metadata response as potentially committed and uses reference-aware cleanup instead of immediately deleting the staged object. [Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).

D1 batches execute sequential statements as a transaction and roll back on failure. The examined code uses that boundary for metadata, receipts and domain mutations; it does not need a global Durable Object to serialize every file write. Direct D1 queries use the primary by default; replication is opt-in through Sessions, so these paths are not silently relying on stale read replicas. [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/).

Important operating limits remain material: D1 allows 50 queries per free-tier Worker invocation versus 1,000 paid, a 2,000,000-byte row/string limit and 100 bound parameters; Workers have a 128 MB isolate memory limit and a much smaller free-tier CPU allowance than paid deployments. Local success with a 25 MiB attachment or 10,000 reminders does not certify either hosted tier. Crate's bounded mutation batches and 1.5 MiB reminder-cache value limit are purposeful protections. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

**Transactions and storage.** Files have primary-key paths and portable-path uniqueness; identities and receipts have database uniqueness constraints. The namespace guards supplement constraints for ancestor/descendant collisions. Input/body limits, strict path validation and bounded parsing help contain adversarial inputs. Settings use a separate conditional object-update path. Old file bytes and changelog entries have 30-day retention; operation receipts use the longer retry policy. Cleanup is bounded, so persistent errors can produce backlog and cost rather than immediate destructive fallback.

**Migrations and rollback.** Empty deployments initialize from bundled, verified schema. Known schemas 2/3/4 upgrade additively to 5; unknown schemas are refused. Deployment/update/reset fencing prevents cooperating current clients from issuing conflicting infrastructure mutations. A lost external API response deliberately retains the fence because a provider action may still complete. The operator must establish quiescence before releasing it. This can require support intervention but avoids inventing a safe lease expiry that the provider does not enforce.

The fence cannot constrain an old client or a direct Cloudflare administrator. Rollback must keep additive tables and use a compatible Worker; restoring an old database alone would roll back receipts while leaving later objects and clients alive. The existing deployment/recovery documentation recognizes these boundaries.

**Failure behavior:**

| Failure | Expected result |
| --- | --- |
| R2 staging fails before D1 publication | Prior live revision remains; upload fails |
| D1 rejects the conditional commit | Current file remains authoritative; staged object is cleanup material |
| D1 response is lost after commit | Upload receipt recovery determines the result; restore has F01 |
| R2 read missing/corrupt for a live row | Explicit integrity/unavailability error, not a deletion signal |
| DO dispatch/projection fails | Durable job/source state and cron allow recovery; UI diagnostics expose backlog |
| Push provider fails persistently | Bounded retries/deadline, terminal failure information; no endless hidden retry |
| Cloudflare account or daily quota unavailable | Sync/notification progress stops; local content remains usable and pending writes need retention |

**Observability and recovery are meaningful strengths.** Structured mutation logs carry request/session/operation IDs and revisions; private plugin history records paths; shareable exports omit private content. Diagnostics report queue depth, failures, maintenance status and retained objects. Traces are bounded and are not a complete audit ledger. For support, retain the current approach and add restore operation IDs to the same trail when fixing F01. Hosted acceptance should verify that an operator can correlate one deliberately failed end-to-end operation without sharing note text.

The backup CLI exports a paired D1/R2 archive, verifies referenced bytes, supports interrupted operations and restores into isolated resources with credentials/subscriptions cleared. The 24 automated recovery tests passed. The independent-account restore rehearsal is still required by F04.

## 8. Obsidian plugin assessment

The plugin entry remains small and delegates startup/settings/feature ownership. Runtime start/stop and reconfiguration are serialized; event handling is gated during transitions, and background work uses cancellation/state checks. Listener ownership and cleanup are represented in plugin/runtime lifecycle tests. Reload is not treated as permission to forget uncertain uploads.

Filesystem events feed queued changes; Crate's own application events are reconciled against the acknowledged state rather than assumed to be new user intent. Rename dependencies survive checkpoints. Unreadable files are not evidence of local deletion. Deferred application and upload failures stop downstream deletion from certifying a destructive partial pass.

The strongest host-specific protection is the comparison **inside** Vault.process or adapter.process for supported text, after the network work. A pre-download hash check alone would not provide this protection. Conversely, the host has no suitable atomic binary compare-and-swap in this implementation. Existing binary changes are kept as incoming review copies; the README documents this. This is a deliberate safety limitation, not automatic attachment convergence. Missing hidden paths also take the review path because an unsafe adapter write could replace a racing local creation.

Users therefore need to understand that a binary review is not necessarily evidence of two people editing concurrently. The current conflict record uses the concurrent-edit cause even for this host limitation. The review message itself explains that the original should be replaced after inspection. Keep this distinction visible as the conflict UI evolves; do not “fix” the inconvenience by replacing binaries with an unchecked asynchronous write.

Actual desktop/minimum-version/mobile API semantics are the main remaining uncertainty. The integration harness simulates the Obsidian filesystem surface and does not prove event order, OS trash behavior, sandbox paths, background suspension or other plugins' writes. F03 is a concrete example of a topology assumption that passed existing harness tests.

### F08 — Verification progress can repeatedly restart before reaching later files

- **Severity:** MEDIUM
- **Classification / confidence:** Architectural risk / High
- **Area:** Missed filesystem events, large-vault verification, restart behavior
- **Problem:** The rotating verification cursor lives only in memory and restarts at the beginning after plugin reload.
- **Why it matters / sequence:** An external tool changes a late-sorting file while preserving size and mtime, and no event reaches Crate. The user repeatedly opens short sessions that verify only the first portion of a large vault. Each reload starts that portion again, so the changed file can remain unsynchronized indefinitely until a full verification or another useful event occurs.
- **Files / symbols:** [LocalContentVerifier](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/sync/content-verifier.ts:18), [verification policy](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/content-verification.md:1), [default interval](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/plugin/settings-types.ts:39).
- **Root cause:** Fairness is guaranteed within a sufficiently long runtime, not across runtimes.
- **Recommended change:** Persist a lightweight cursor or rotate the starting point across sessions. Keep explicit full verification available and report when the last complete sweep finished. Do not make all startup paths synchronously hash the whole vault.
- **Proving tests:** Repeated restarts with a fixed late-sorting same-size/mtime edit, changing file sets, failed reads, and large files that exhaust the byte budget; eventually discover every eligible stable file without relying on its event.

At the documented 32-file budget, 10,000 small files need up to 313 successful verification checks. At a five-minute interval that is roughly 26 hours if those are the only checks. Extra incremental runs can accelerate it; large files and interruptions can extend it. Atomic remote text application still protects a current local preimage, so this finding is about discovery/progress, not a proven overwrite.

## 9. PWA assessment

**Offline semantics are narrower than “edit anything offline.”** Cached browsing is read-only when offline. An editor already open or an in-flight change can survive connection loss through the draft/outbox paths. Saved commands are persisted before optimistic acknowledgment, serialized through Web Locks where supported, and retried with their original identity. Definitive rejection and ambiguous outcome have different recovery behavior. The app does not blindly roll back an uncertain committed write.

The existing browser suite meaningfully covers reload, lost responses, multiple tabs, session renewal, stale generations, quota errors, corrupted outbox records, IndexedDB migration/crash/block cases, update coordination, expiry and saved-change recovery. Authentication is scoped by deployment origin/token/folder; a new folder does not automatically adopt another folder's pending edits. Explicit logout clears private state, while expiry preserves recoverable work.

**Service-worker design.** Only the generic app shell, versioned assets and icons are cached. Authenticated reminder API responses are not served through CacheStorage. The private offline snapshot is a separate scoped IndexedDB concern. Installation precaches lazy chunks as well as startup assets. Active-client version reporting retains old shell caches needed by open clients; unknown clients prevent premature collection. Activation and reload are coordinated with active editors and mutations.

An old app can remain open while newer releases exist; protocol negotiation must fence unsupported writes. Cache loss during an upgrade remains a useful additional fault-injection case: an old hashed lazy chunk may no longer exist on the deployed server if its cached copy is gone. Do not claim that retaining caches proves indefinite availability across arbitrary storage eviction.

IndexedDB migrations are additive/transactional, unknown newer formats are preserved, and known disposable cache corruption has an explicit rebuild path. Quarantined pending changes retain original text for export. This is materially better than deleting all storage after any parsing exception.

### F05 — A token-storage exception aborts logout before private UI is cleared

- **Severity:** MEDIUM
- **Classification / confidence:** Confirmed bug / Confirmed
- **Area:** Session lifecycle and privacy failure handling
- **Problem:** resetLocalSession removes the stored auth token before clearing in-memory authentication, rendered reminders and the offline snapshot. That removal is outside a guard.
- **Why it matters:** Browser storage can become unavailable after the application loads. A logout action should still clear the current screen and report incomplete persistent cleanup.
- **Concrete sequence:** Load authenticated reminders; make token removeItem throw a SecurityError; make remote revocation unavailable; select Log out. The promise rejects before the UI reset. The auth token and rendered reminder remain, and no signed-out screen appears. This was reproduced in Chromium and WebKit with the production PWA.
- **Files / symbols:** [resetLocalSession](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/hooks/usePwaSessionLifecycle.ts:69), [performPwaLogout](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/hooks/usePwaSessionLifecycle.ts:18), [logOut](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/hooks/usePwaSessionLifecycle.ts:136).
- **Root cause:** Persistent cleanup is a prerequisite for the in-memory privacy boundary instead of an independently fallible operation.
- **Recommended change:** Clear current authentication/UI in a guaranteed path; attempt each persistent cleanup independently and report which could not finish. Preserve the explicit instruction to clear site data/revoke the session when browser storage cannot be changed. Do not claim the persistent credential was erased when it was not.
- **Proving tests:** Throw separately on token deletion, draft access, outbox deletion and IndexedDB clearing; combine each with failed/hanging remote revocation and multiple tabs. The current page must become unauthenticated and private content disappear, with an actionable cleanup error.

This is not evidence that routine logout leaks private content through the service-worker cache. Normal logout tests passed, and that cache is intentionally generic.

### F06 — Uncommitted browser changes remain vulnerable to origin-storage eviction

- **Severity:** MEDIUM
- **Classification / confidence:** Architectural risk / High
- **Area:** Offline data durability
- **Problem:** The outbox uses localStorage and drafts use sessionStorage; no persistent-origin storage request or persistence-status handling was found.
- **Why it matters / sequence:** A change is saved locally but cannot reach the server. The application is closed; the browser later evicts site storage under pressure. The only uncommitted copy disappears. Database rebuild and server receipts cannot reconstruct bytes the server never received.
- **Files / symbols:** [outbox storage](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/reminder-outbox-storage.ts:141), [draft storage](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/reminder-drafts.ts:1), [snapshot database](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/reminder-cache-database.ts:1).
- **Root cause:** Successful browser writes are being used for durable pending intent, but origin storage remains subject to browser lifecycle policy.
- **Recommended change:** Request persistent storage where supported, expose its result without overpromising, make export accessible for ordinary long-pending changes, and clearly distinguish “saved on this device” from server-confirmed. Existing saved-change export components provide a starting point.
- **Proving tests:** Persistence grant/denial/unsupported cases; export and re-import/compare of uncommitted changes; simulated storage deletion followed by startup with no false “synced” claim. Physical storage-pressure behavior belongs in acceptance.

WebKit documents best-effort eviction and persistence heuristics. Installed Home Screen web apps have different inactivity treatment from normal Safari; a blanket claim that installed PWAs lose their data after seven days would be incorrect. Persistence also cannot prevent deliberate user clearing or device loss. [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/), [WebKit tracking prevention](https://webkit.org/tracking-prevention/).

**Reminder domain and notifications.** Shared date/recurrence functions distinguish date-only calendar values from timed instants. Persisted recurrence timezone and rule state are preferable to recalculating a natural-language phrase independently on each client. Relative schedules are normalized by the plugin; unsupported/unverified sources are reported rather than scheduled from uncertain text. Completion, recurrence advancement, reordering and multi-file moves are validated against current source, with receipts protecting replay.

The completion model is specific: completing an active recurring task advances its scheduled date and increments completedCount while leaving it open when a next occurrence exists. At the count/end boundary it becomes completed. Reopening a terminal completed recurrence decrements the count without moving its displayed date backwards. It is not a general undo of an already advanced occurrence. The core plan preserves the stable reminder marker. See [buildReminderCompletionPlan](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/core/markdownReminderMutation.ts:184) and [calculateNextOccurrence](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/reminders/utils/recurrenceCalculator.ts:20).

Create/update/delete and reorder operations revalidate the Markdown source and structural context. Unsafe nested-task or supporting-paragraph moves are rejected instead of reconstructing a lossy approximation. General deletion has confirmation rather than a domain undo ledger; rich-text editor undo is a separate local editing feature. Stable markers and duplicate-owner quarantine are essential because file paths and line numbers alone would not survive note edits. Plugin reminder moves have destination-first journal recovery; web moves coordinate both changed files through the server transaction. These paths deserve continued shared-contract tests whenever the Markdown representation changes.

No new DST or recurrence arithmetic defect was demonstrated. Existing date/recurrence, source-migration and persisted-schedule tests are relevant protection. Expand acceptance around timezone change during an open editor, skipped/repeated DST hours, all-day completion on two devices, recurrence count/end boundaries, and offline completion arriving after a source edit.

Durable Objects verify current source/policy/recipient authority before delivery. They preserve occurrence and recipient progress, bound retries, and quarantine duplicate/unverified reminder ownership. Exactly-once display is not guaranteed across the external push acceptance/receipt gap. Tags help coalesce visible notifications but cannot undo a notification already seen or dismissed.

Push subscription changes are repaired when the app next opens; there is no reliable background resubscription guarantee. Revoked permission and long app inactivity can therefore lead to missed notifications. Ordinary mutation replay also runs while the app is open and connected; it is not a guaranteed OS background-sync service.

## 10. Security assessment

Authentication, authorization and deployment ownership are treated seriously. Vault credentials are hashed in D1; plugin secrets are kept through the Obsidian secret-storage service; OAuth uses state and PKCE, with transient provider access used to provision/register the device and then discarded. PWA enrollment grants are short-lived and scoped, browser sessions expire, and server routes enforce folder scope rather than trusting the browser's folder parameter.

The ownership boundary is the user's Cloudflare account and deployment. There is no second unrelated user's row inside a shared SaaS database in the current design. A vault credential intentionally authorizes its vault; a web credential has narrower reminder authority. Adding collaborative users later would require a new authorization model.

| Surface | Assessment |
| --- | --- |
| Path traversal / portable collisions | Central validation and namespace checks; literal prototype-name paths covered by integration tests |
| SQL injection | Parameter binding and validated query construction in examined routes |
| XSS / unsafe Markdown | Escaped text and controlled link handling; no demonstrated raw user-HTML execution |
| CSP / framing | Self-oriented script/connect policy and protective response headers; no demonstrated unsafe remote code loading |
| CORS / CSRF | Wildcard CORS is not by itself an auth bypass: these APIs use explicit bearer headers, not ambient authenticated cookies |
| SSRF through push endpoints | HTTPS provider allowlist, URL validation, no credentials/custom ports, redirect rejection and timeout |
| Secret handling | No scanner findings; embedded OAuth client ID is a public-client identifier, not a client secret |
| Cached private data | API responses excluded from service-worker cache; scoped private local snapshots and explicit logout cleanup, with F05 exception handling gap |
| Logs and diagnostics | Structured opaque identifiers and bounded traces; private history/journals require review before sharing |
| Public abuse | F02 is a confirmed availability defect; hosted API cost and quota monitoring remain necessary |
| Account compromise / server-side privacy | The account owner and Cloudflare-hosted server can access vault content; this is not end-to-end encryption against the storage provider |

The npm advisory result is a snapshot, not a guarantee about future advisories. The lockfile, checksum-pinned secret scanner, SHA-pinned Actions, read-only build permissions, separated release permissions and artifact verification are strong supply-chain controls. Install scripts in the resolved lockfile are associated with Parcel watcher, esbuild, fsevents and workerd; these are native tooling/bootstrap dependencies, not unknown application telemetry packages. They still execute during development/CI installation, so keep untrusted PR build jobs away from release credentials.

Dependency notices and the automated notices check are present. Weekly npm/Actions update configuration exists. GitHub's separate **Dependabot security updates** setting was reported disabled even though secret scanning and push protection were enabled. Enabling automated security-fix PRs would complement the existing scheduled updates; this is a small operational improvement, not evidence of a current vulnerable package.

## 11. Missing test matrix

“Adequate” below means protected for the scoped local behavior, not certified on physical devices. Existing seeded multi-device tests and state-machine tests are credited; the missing work is broader composition and real-host coverage.

| Scenario | Existing evidence / current adequacy | Missing or required extension |
| --- | --- | --- |
| A edits / B edits | Adequate scoped coverage: reconciliation, merge and real-engine integration | Generate more overlapping edits, encodings and restart schedules |
| A edits / B deletes | Covered by reconciliation/engine tests | Combine with restart and lost receipt at each boundary |
| A deletes / B edits | Covered; edited content survives rather than blindly honoring stale deletion | Assert the user-visible conflict outcome on physical devices |
| A renames / B edits | Real-engine scenario preserves renamed and edited-original copies | Cross-note links and folder topology |
| A renames / B renames | Planner/history and rename-preservation coverage | Broader chained/nested rename histories across three clients |
| Delete / identical-byte recreate | Adequate real-engine history regression | Extend to restore and directory transitions |
| Three-device concurrency | Three seeded histories plus disconnected merge tests | General generated histories with delete/restore/topology and invariant checking |
| Plugin / PWA concurrency | Reminder file CAS, semantic revisions, merge recovery tests | One composed run with real plugin UI and PWA on a hosted deployment |
| Long offline periods | Cursor expiry/fallback, operation-expiry tests | Weeks/months with token renewal, checkpoint migration and content-retention expiry together |
| Network failure before request | Journal/outbox tests preserve intent before dispatch | Physical storage denial immediately before persistence |
| Network failure during request | Transport/failure and interruption tests | Slow hosted uploads plus mobile background/kill |
| Network failure after server commit | Strong upload/reminder receipt tests | **F01:** restore replay after a later deletion |
| Duplicate requests | Receipts tested for uploads, deletes and reminders | Restore duplicate/rejected-outcome persistence |
| Out-of-order requests | CAS, stale-delete and seeded histories | All mutation families, not only ordinary uploads |
| Client crash during sync | Persistent simulated devices, upload/merge recovery | OS process kill during actual adapter application/trash |
| Backend failure during sync | D1/R2 commit, response-loss and staging failure tests | Hosted quota/CPU termination and real external push acceptance gap |
| Local checkpoint/journal corruption | Validation, backups, blocked recovery tests | User-guided recovery without discarding bytes; full composite scenario |
| IndexedDB corruption | Native Chromium/WebKit recovery/quarantine tests | Origin-wide eviction and storage-pressure acceptance |
| Migration failure | IndexedDB crash/block/newer-version and deployment/schema tests | Actual prior released app bundles crossing each supported upgrade |
| Old client / new backend | Protocol rejection/reads tested | **F10:** a supported N/N−1 execution matrix |
| New client / old backend | Capability/range validation | Actual supported older deployment and pending operation replay |
| Multiple PWA tabs | Locks, storage events, renewal/logout and duplicate replay tests | Storage failure during logout, delayed/suspended peer events together |
| Service-worker version mismatch | Install/update/cache/version-lifecycle tests | Cache eviction or missing lazy chunk while an old tab stays open |
| PWA killed during synchronization | Reload and outbox recovery | Physical process termination after persistence and after remote commit |
| Quota exceeded while saving | Browser storage failure tests preserve editor | Eviction after successful write; F06 |
| Logout while storage unavailable | **Audit reproduction fails intended privacy boundary; F05** | Permanent regression after fixing cleanup order |
| Notification permission revoked | Registration/re-registration tests | Physical installed iOS/Android permission and OS delivery behavior |
| Notification duplicate/missed delivery | Source/recipient/occurrence integrity and retry tests | Crash after external provider accepts, before progress storage |
| DST and timezone changes | Shared date/recurrence unit tests; persisted schedule tests | Physical timezone change with open editor, recurrence and delayed completion |
| All-day / recurring completion races | Domain and semantic mutation coverage | Two devices completing an occurrence across a timezone/day boundary |
| 1,000 / 10,000 notes | Local sync capacity and cursor/page tests | Hosted CPU, D1 rows read, device memory and slow network |
| 1,000 / 10,000 reminders | Worker capacity tests and browser rendered-row bounds | Real folder layout at per-file limits, installed mobile memory |
| Exact 25 MiB file boundary | Actual Worker/D1/R2 integration passes | Hosted free/paid limits and low-memory mobile application |
| Folder ↔ file replacement | **Audit reproduction exposes F03** | Real adapter tests with hidden/ignored/concurrent children |
| Anonymous rate-budget exhaustion | Existing limiter tests protect cost ceiling | **F02:** availability for valid callers under invalid traffic |
| Paired backup / isolated restore | 24 Python recovery tests | Independent hosted account and fresh client re-enrollment |
| Minimum Obsidian / unload/reload | Mock lifecycle coverage | Exact declared version and physical desktop/mobile acceptance |
| Visual and accessibility | Behavior/focus tests; 28/52 local visual pass | F07 zoom and F09 platform-sensitive time-input snapshots |

For the next state-machine iteration, generate operations over paths, their directory relationships, content revisions, operation IDs and crash points. Track which byte sequences must remain live or recoverable, and assert convergence only after deliberately unresolved review conflicts are settled. Include shrinking/replayable seeds so a failure produces a small actionable sequence.

## 12. UI/UX assessment

The implementation contains purposeful loading, empty, error, partial-indexing, pending-write, conflict and recovery states. Optimistic operations retain recoverable input; ambiguous writes are not falsely presented as rejected. The UI exposes source issues and quarantined state rather than silently dropping invalid reminders. Settings, dialogs and list controls use semantic roles and focus behavior, and browser tests exercise keyboard, sheets, reorder, pagination and scroll preservation.

Several distinctions matter to users:

- “Last successful sync” must remain separate from a failed current connection check; the implementation maintains this distinction.
- “Remote restore succeeded” and “local synchronization finished” are separate outcomes; the current generic restore-failed notice can obscure that difference, reinforcing F01.
- A binary incoming-review copy may be required solely because the host lacks an atomic writer. It should not imply that both devices edited the file.
- Pending PWA text is only locally retained until confirmed; an offline cached list does not imply arbitrary offline editing is supported.
- Unsupported reminder sources are incomplete productivity views of intact Markdown, not missing vault files.
- Expired unresolved uploads are a recovery problem, not a reason to recommend force sync or metadata deletion.

### F07 — The PWA suppresses user zoom

- **Severity:** MEDIUM
- **Classification / confidence:** Confirmed bug / Confirmed
- **Area:** Mobile accessibility
- **Problem:** The viewport sets maximum-scale=1 and user-scalable=no, while a hook prevents Safari gesturestart/gesturechange defaults.
- **Why it matters / scenario:** A low-vision user needs to enlarge reminder text or controls. The app actively suppresses the native zoom gesture on supporting browsers.
- **Files / symbols:** [PWA viewport](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/cloudflare/worker/pwa/html.ts:17), [usePwaViewportGestures](/Users/kaanbiryol/Documents/Projects/obsidian-crate/src/pwa/hooks/usePwaViewportGestures.ts:4).
- **Root cause:** Whole-page gesture suppression is used as a mobile interaction control.
- **Recommended change:** Allow native page zoom. Address accidental gestures on individual draggable controls without disabling accessibility across the application.
- **Proving tests:** Physical Safari/installed iOS and Chromium zoom; large text and 200%/400% layouts; editor, settings and reminder controls remain reachable without clipped actions or lost focus.

### F09 — Visual checks depend on native time-control rendering outside the fixture

- **Severity:** MEDIUM
- **Classification / confidence:** Missing protection/test / Confirmed failures; High confidence in the sampled cause
- **Area:** Visual regression portability and contributor experience
- **Problem:** The separate local visual suite fails 24 date/weekly/monthly snapshots. Inspected actual/baseline pairs differ in native time-input rendering: 09:30 versus 09:30 AM.
- **Why it matters / scenario:** A contributor with a different system time-format preference gets many screenshot failures despite the same fixed clock, locale, timezone and logical input value. Useful behavioral assertions after the screenshot can be skipped by the early failure.
- **Files / symbols:** [shared visual tests](/Users/kaanbiryol/Documents/Projects/obsidian-crate/tests/visual/shared-ui.spec.ts:7), [Playwright configuration](/Users/kaanbiryol/Documents/Projects/obsidian-crate/playwright.config.ts:1), [visual workflow](/Users/kaanbiryol/Documents/Projects/obsidian-crate/.github/workflows/visual.yml:1).
- **Root cause:** Native form-control presentation depends on more environment state than the fixture controls. The tests already freeze time; this is not an unfrozen-today explanation.
- **Recommended change:** Pin the remaining rendering environment or mask only the native presentation in snapshots while separately asserting its value, label and interaction. Run important keyboard/focus assertions independently of pixel comparison. Review baseline changes instead of broadly relaxing the threshold.
- **Proving tests:** Run under 12- and 24-hour preferences on the supported snapshot OS; logical time and keyboard semantics must match and snapshots must have an intentional stable policy.

The inspected images do not demonstrate a broken date value or a general layout regression. No baselines were changed during this audit.

## 13. Performance/scalability assessment

The architecture contains useful bounds: hash and request-size limits; bounded transfer batches; paginated metadata/change feeds; bounded cache warming; 30-day content/history retention; bounded receipt pruning; limited notification projection work; and a 200-card PWA page size.

**Measured production artifacts** from the isolated build, using the repository's budget checker:

| Artifact | Raw KiB | gzip KiB | Interpretation |
| --- | ---: | ---: | --- |
| Plugin main.js | 1,444.60 | 790.67 | Includes compressed deployment artifacts; startup/mobile impact still needs physical measurement |
| Plugin styles.css | 138.39 | 18.98 | Passes the CSS scope and budget gates |
| Worker bundle | 1,307.45 | 583.22 | Within the configured budget |
| PWA entry | 121.38 | 38.29 | Entry alone understates actual startup transfer |
| PWA startup assets | 449.53 | 151.88 | Budget is 450.20 / 151.95 KiB: very little headroom |
| All PWA assets | 478.18 | 162.90 | Lazy assets are also precached for safe updates |

The budgets are enforced and pass, but several sit very close to present output. Treat them as change-detection thresholds, not evidence of a comfortable mobile latency budget. Avoid increasing them automatically when a new dependency tips the limit.

**Browser samples from this audit:** synthetic local API, 390 × 844 viewport, unthrottled desktop browsers, service workers disabled in the capacity fixture:

| Browser / reminders | Payload bytes | First usable list | Open editor | Save | Mounted cards |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium / 1,000 | 227,712 | 207 ms | 167 ms | 782 ms | 200 |
| Chromium / 10,000 | 2,306,714 | 240 ms | 167 ms | 1,334 ms | 200 |
| WebKit / 1,000 | 227,712 | 256 ms | 183 ms | 1,824 ms | 200 |
| WebKit / 10,000 | 2,306,714 | 341 ms | 178 ms | 1,398 ms | 200 |

These are local samples, not hosted service or physical-phone latency guarantees. Browser paging bounds DOM work, but the whole folder still travels, is parsed and is kept for cache/reorder state. Server capacity tests use realistic file layouts separately; the browser fixture does not prove 10,000 reminders fit in a single permitted Markdown source.

**Likely scaling boundaries:**

- Full reconciliation is proportional to eligible vault content and hashes every eligible file. At 10,000 notes or many large binaries, disk reads and transfer dominate. Metadata shortcuts improve incremental behavior; F08 covers verification fairness.
- Reminder folder lists and warm-cache decoding grow with folder size. Cache warming is bounded to 20 files/2 MiB per request; many cold source files require multiple requests and deliberate backoff.
- Large-file paths can hold full binary buffers plus encoded transport/journal representations. The 25 MiB functional boundary needs memory and CPU measurements under hosted/physical limits.
- Concurrent devices compete for the same file CAS and single D1 deployment. That is appropriate for a personal vault but can increase retries and scan cost with many devices or hot files.
- Old service-worker caches are retained while live clients need them. Long-lived or unknown clients can delay collection; do not delete those caches merely to enforce an arbitrary small count.
- Local journals/outboxes must retain unresolved user intent. Their growth should be visible, rather than capped by dropping old changes. Server receipt/history pruning and diagnostics already provide useful bounded maintenance.

The highest-value optimization is a hosted/device capacity envelope: measure CPU, D1 rows read/written, memory, transfer size and p95 latency for representative vaults. Introduce a paginated per-reminder server index only if those measurements show the current full-folder response is inadequate.

## 14. Open-source readiness

Contributor and operator documentation is unusually complete: README, architecture, sync/protocol explanations, testing, deployment, diagnostics, source recovery, upload recovery, paired backup/restore, contribution guidance, security reporting, license, third-party notices and issue templates are present. New contributors can trace the major components without reverse-engineering a monolithic plugin entry point.

The release workflow validates manifest/version consistency, uses the exact non-v tag convention, verifies compressed embedded deployment artifacts, enforces size budgets, pins third-party Actions by commit, and prepares a draft release. CI includes isolated reproducibility checks. In this audit, two production builds in the isolated checkout produced identical hashes for plugin JS/CSS, Worker, PWA bundle, manifest and schema. Dependencies were reused from the existing installation; this was not a second independent npm-ci supply-chain reconstruction.

Useful remaining release work is specific:

- Attach the F04 acceptance record to the exact candidate hashes outside public version control, as documented.
- Obtain green CI for the final release commit. The local checkout's two existing test edits also need to be included in whatever commit is submitted for that check.
- Fix F09 or document a reproducible visual environment so contributors can distinguish native-widget differences from regressions.
- Clarify recovery copy: the current runtime fetches its expected hash immediately before dispatch, whereas deployment documentation describes protection from changes since the recovery screen opened. Describe the actual boundary, and improve the distinction between remote restore and subsequent local-sync failure with F01.
- Keep the public security-reporting channel usable and enable automatic advisory-fix PRs if desired; no GitHub settings were changed in this audit.
- Before the first breaking public protocol release, finish F10's compatibility policy.

Independent backup instructions correctly distinguish retained versions from backups. Operationally, the most important newcomer exercise is: install into a clean vault, authorize an independent account, explicitly start initial sync, join a second device, provoke a conflict, then recover a deliberately removed note from an isolated paired archive.

**Audit artifacts and reproduction instructions**

The [Worker reproduction source](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audits/2026-09-11/reproductions.integration.ts.txt:1) contains three tests that assert the bugs exist. Copy it to **src/cloudflare/worker/prerelease-audit.integration.ts**, then run **npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/prerelease-audit.integration.ts --reporter=verbose** using Node 26.8.2. Remove the temporary copy afterwards. For fixes, invert the assertions to express the desired safe outcome and promote them into the permanent relevant suites.

The [logout browser reproduction](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/audits/2026-09-11/logout-reproduction.mjs.txt:1) can be copied to **scripts/prerelease-audit-logout.mjs** and run with **node scripts/prerelease-audit-logout.mjs** using the same runtime. It builds the production PWA, uses synthetic local API responses, and injects a token-storage exception in Chromium and WebKit. Remove the temporary script afterwards.

Logs and the isolated candidate record are available in the ignored [local audit evidence directory](/Users/kaanbiryol/Documents/Projects/obsidian-crate/.generated/pre-release-audit-2026-09-11). They are supporting artifacts, not production source. No real credentials, real vault contents or external mutation requests were used by the reproductions.

## 15. Recommended release plan

**Must fix before release**

1. **F01:** Put restore under the durable intent/receipt contract; preserve the distinction between remote commitment and local application.
2. **F02:** Separate anonymous abuse limits from authenticated notification capacity and add an availability-under-abuse regression.
3. **F03:** Implement safe directory/file topology handling with ignored/hidden/concurrent-child tests.
4. **F04:** Complete the exact-artifact hosted/minimum-version/physical-device/restore matrix, then run CI on the final committed candidate.

**Should fix before release**

1. **F05:** Make logout clear in-memory private state even when storage operations fail.
2. **F07:** Allow native zoom and verify enlarged layouts on physical devices.
3. **F09:** Stabilize native time-input visual tests without masking behavioral failures.
4. **F06:** Expose browser persistence limits and ordinary pending-change export; request persistent storage where available.
5. **F08:** Preserve verification progress across sessions, or clearly expose incomplete sweep progress until implemented.

**Can safely follow after the initial release**

1. **F10:** Add the supported mixed-version execution matrix before introducing the next breaking protocol.
2. Expand generated state-machine histories to include restore, path topology, migrations and clock boundaries together.
3. Optimize full-folder reminder transfer/indexing only after hosted measurements justify it.
4. Improve presentation of intentional binary review and expired-journal recovery.
5. Extend owner-controlled quota/backlog alerting and dependency advisory automation without adding hidden telemetry.

After fixes, rerun the affected repros and regression suites, then the repository release gate. Repeat broad testing when source changes or failures justify it, and bind acceptance to the final rebuilt assets.

## 16. Highest-value improvements

If only five improvements fit before release, I would prioritize:

1. **Durable restore intent and receipts.** Closes the proven resurrection path in the tool intended to recover user data.
2. **Safe local path-type transitions.** Eliminates a valid remote state that currently cannot converge on another device.
3. **Authenticated notification quota isolation.** Prevents a cheap anonymous denial of normal enrollment/subscription operations.
4. **One exact-candidate acceptance campaign.** Exercises independent-account OAuth, minimum Obsidian, physical iOS/Android, hosted limits/push and paired restore; covers risks local harnesses cannot establish.
5. **Failure-safe logout.** Clears the private UI independently of browser-storage and network cleanup failures, with explicit recovery guidance.

These address demonstrated failures and the most consequential evidence gap. A general codebase refactor would reduce less immediate release risk.

## 17. Release-readiness score

**Overall: 82/100**, an approximate equal-weight average. This is engineering judgment about this candidate, not a quantitative probability of avoiding data loss.

| Category | Score | Main factors |
| --- | ---: | --- |
| Architecture | 86 | Clear ownership and shared domain logic; restore is outside the common durable mutation contract |
| Sync correctness | 78 | Strong CAS/receipt/merge/delete protections; reproduced restore and topology failures |
| Data safety | 82 | Immutable versions, journals, guarded writes and paired recovery; finite retention and browser-only pending bytes remain limits |
| Backend reliability | 78 | Sound transactional boundaries and recovery queues; anonymous quota denial and unverified hosted envelope |
| Obsidian plugin | 78 | Careful lifecycle/local-apply design; adapter simulation, directory transition and verification fairness gaps |
| PWA | 78 | Extensive storage/outbox/update/multi-tab protection; logout exception, eviction and physical platform gaps |
| Security | 80 | Strong auth/scope/path/headers/supply-chain posture; confirmed notification abuse and logout cleanup weaknesses |
| Testing | 88 | Broad failure-oriented unit/runtime/browser tests, including seeded multi-device histories; missing composed boundaries and real-host evidence |
| UI/UX | 80 | Clear pending/recovery states and interaction tests; zoom suppression and ambiguous restore/review distinctions |
| Open-source readiness | 92 | Strong documentation, licensing, notices, CI and recovery tooling; final candidate CI/acceptance and visual portability remain |

The main distance from 100 is not a lack of abstractions or more test-count padding. It is inconsistent replay safety for restore, one unhandled filesystem topology, an abuse-control design that denies legitimate users, and incomplete evidence on the environments the release promises to support.

**Would I personally approve this repository for public release today? No.** I would approve a candidate after F01–F03 are corrected and F04 is evidenced, with the remaining MEDIUM findings tracked explicitly. Crate is close to a defensible release, but the known defects should not be delegated to its first users to discover.
