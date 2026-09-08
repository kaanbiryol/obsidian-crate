# Crate final pre-release assessment

Assessed code: **`bb14136`**, Crate **0.1.0**, September 8, 2026. This report follows the [original audit](pre-release-engineering-audit-4b6c291.md), [first remediation round](audit-remediation.md) and [fresh second audit](second-audit-remediation.md). Historical reports describe their own candidates and are not current defect lists. The report/evidence commit changes documentation only; the executable candidate is identified here and by SHA-256 in the [acceptance record](audit-evidence/remediation/final-bb14136/README.md).

## 1. Executive summary

**Readiness: 87/100. The code is ready for controlled release-candidate testing. I would not approve an unrestricted public plugin release today, because the required hosted and physical-device acceptance evidence is incomplete.**

All actionable code findings from the first round, F01–F16 and S01–S11, are fixed. The second audit reproduced and fixed six additional findings, each in a separate commit: incorrect returned reminder state, destructive/ambiguous durable title parsing, unsafe damaged-draft restore, excessive cold-upload requests, exceeded PWA bundle budgets, and duplicate reminder panes during actual Obsidian reload. A separate commit removed an obsolete helper caught by the release gate. No confirmed BLOCKER, CRITICAL or HIGH code defect remains open from these audits.

The strongest improvement is at system boundaries: current Markdown is protected against stale indexes; I/O failure cannot authorize deletion; checkpoints cannot silently cross deployments; browser intent survives involuntary authentication changes; receipt expiry cannot re-enable old commands; and derived reminders cannot prevent ordinary file bytes from being saved. These are implemented invariants with failure-injection regressions, rather than new abstractions without demonstrated benefit.

The final local gate covers **1,562 unit tests, 225 real local Worker/D1/R2 integration tests, 22 recovery tests, 19 browser acceptance scripts using Chromium/WebKit, and 48 visual tests**. Lint, three TypeScript targets including visual fixtures, dead-code checks, notices, CSS scope, artifact validation, dependency advisory checks and history/source secret scans pass. Clean builds on Node 20.19.0, 22.12.0 and 24.0.0 produce identical plugin, style, manifest, Worker and PWA payload hashes. Exact results and limitations are retained in the acceptance record.

Real Obsidian **1.13.7** was exercised in a separate disposable vault with networking for Crate disabled. Create/edit/complete, project movement, recurring advancement/reopening, stable identity, keyboard editor activation and reload persistence passed. Five rapid reloads and three concurrent opens now retain one pane and ten commands. This does not establish the declared minimum **1.13.0**, mobile filesystem behavior, hosted sync, real push delivery or independent-account restoration.

The GitHub repository is already public. The decision above concerns shipping the plugin and its deployment as a supported public release. No changes were pushed, no tag/release was created, and no Cloudflare deployment or user vault was modified by this remediation.

## 2. Release blockers

There are **no remaining reproduced code blockers** from the audited corpus. The following are release acceptance gaps, not claims of demonstrated corruption. They remain open under S12.

| ID / classification | Problem, impact and concrete exposure | Relevant implementation / root cause | Required evidence |
| --- | --- | --- | --- |
| E01 — HIGH, confirmed missing test; hosted deployment/recovery | OAuth, update fencing and archive restoration pass local tests, but an unrelated account's permissions, resource bindings or provider response can still differ. A first-time user could fail enrollment or discover that a purported backup cannot restore service. | [Provisioner](../src/cloudflare/provisioner.ts), [deployment fence](../src/cloudflare/deployment-fence.ts), [recovery tools](../scripts/recovery/), [runbook](recovery.md). Local bindings/CLI fixtures do not exercise a live account. | Complete OAuth → explicit upload → second-device join → update/interruption recovery; archive the exact deployment and restore into independent empty resources, verifying all referenced bytes, receipts and re-enrollment. |
| E02 — HIGH, confirmed missing test; supported hosts and notifications | A mobile OS can suspend the client between filesystem operations or delay/reject installed-app push. A successful desktop Chromium/WebKit test cannot establish those host transitions. The claimed minimum Obsidian version has not been installed. | [Plugin lifecycle](../src/plugin/CratePlugin.ts), [move journal](../src/reminders/data/reminder-move-journal.ts), [manifest](../manifest.json), [release checklist](release-checklist.md). Only Obsidian 1.13.7 desktop was available. | Install the recorded artifacts on Obsidian 1.13.0, physical iOS and Android; test sync/conflicts/background/reload and installed-PWA notification delivery, permission changes and session renewal. Raise the minimum only if testing demonstrates a higher requirement. |
| E03 — MEDIUM, confirmed missing test; release artifact chain | Local builds are reproducible, but this commit has not been pushed through hosted CI, the community review scanner or the draft-release workflow. A packaging/environment difference could still produce a failing distributable. | [Build workflow](../.github/workflows/lint.yml), [release workflow](../.github/workflows/release.yml), [artifact verifier](../scripts/verify-release-artifacts.mjs). Current fixes are local commits. | Run the hosted three-version gate and community Review branch scan, reproduce assets, then retain the draft's checksums and provenance with the completed checklist. |

E01/E02 block my release approval because the product edits valuable vault data and advertises cross-device reminders. Their severity describes the missing assurance for those promises; it does not imply that local tests have found another data-loss bug. The concrete acceptance checklist is ready to run when those environments are available.

## 3. Critical/high-priority findings

The original two BLOCKER, two CRITICAL and six HIGH findings are resolved; the remediation tracker records their reproductions and proofs. The second round's findings are also closed:

| Finding | Severity | Concrete before → after | Commit / proof |
| --- | --- | --- | --- |
| R01: mutation result differs from saved reminder | MEDIUM | Completing recurrence returned the old due date/count; mutation APIs now return the committed index state. | `c6bf65c`; real repository/writer/rescan tests |
| R02: durable parser changes protected title text | HIGH | A linked “Weekly report” title could invalidate recurrence; a linked priority marker could disappear. Indexed protected matches now preserve literal ranges and select appended schedule metadata. | `35351e0`; parser version 7, round-trip and real Worker cache/migration tests |
| R03: malformed or colliding saved draft is destroyed | HIGH | Invalid fields reached the editor and close could delete the only raw copy. Validation now leads to exact export and guarded reviewed removal. | `93788f9`; unit plus native Chromium/WebKit recovery tests |
| R04: cold reconciliation amplifies uploads | MEDIUM | 10k notes required 20,002 requests; bounded three-file batches reduce this to 6,722 without relaxing publication guards. | `70e005e`; actual engine/Worker capacity and uncertain-commit tests |
| R05: recovery features exceed delivery budgets | MEDIUM | Startup loaded recovery controls unconditionally and the release gate failed. Deferred controls preserve focus and handle asset failure; explicitly revised budgets now pass. | `6ff98a5`; browser recovery/focus and artifact checks |
| R06: plugin reload adds reminder panes | MEDIUM | A transient empty view was mistaken for absence. A single attached pane reservation survives module reload; construction/reveal are awaited and serialized. | `bb14136`; regression tests and actual Obsidian reloads |

Detailed root causes, sequences, relevant symbols and regression requirements are in the [second audit record](second-audit-remediation.md). R05 includes a deliberate budget increase, not a claim that the original limits were met. No broad architecture rewrite was used to address these failures.

## 4. Sync correctness assessment

The plugin maintains local bytes, a common manifest and merge bases. Initial upload and full reconciliation discover local/remote state; incremental sync combines vault changes with a server change cursor. The shared [classifier](../src/sync/reconciliation.ts) decides each path from local, remote and common state. Expired cursors fall back to complete reconciliation. Failed discovery stops planning; transfer-time checks revalidate local absence and current bytes before destructive actions. Periodic byte verification also catches changes hidden by equal size/mtime.

An upload stages immutable bytes in R2, then conditionally publishes the D1 file pointer, revision, history and projection intent. Deletes consume an exact revision and write a correlated deletion receipt in the publication transaction. Downloaded bytes are checked before guarded local application. Successful transfers update checkpoints; unresolved work cannot be hidden by advancing the remote cursor. Main/tmp generations support restart recovery and are bound to normalized server authority.

Concurrent non-overlapping Markdown edits can merge using a trusted common base. Otherwise both versions remain recoverable, including visible conflict copies. Binary updates require review where an atomic host write cannot be guaranteed. Edit/delete races favor the changed content and surface the conflict. Generic file rename is represented by independent path changes; rename/edit and divergent renames may preserve multiple paths rather than infer a user's preferred name. Dedicated reminder moves add transactionally guarded backend publication and a durable local two-file journal.

PWA mutations carry semantic revisions and immutable operation IDs/bodies. An atomic receipt confirms exactly the original mutation, including a committed request whose response was lost. Old whole-form edits cannot overwrite a reminder changed by the plugin. Protocol 6 issues the operation date from the server, accepts that date and the next 179 UTC dates, and checks expiry again inside publication. A monotonic cleanup floor prevents clock rollback from reopening pruned requests. Expired uncertain work is retained for review/export rather than silently retried under a new identity.

These guarantees are bounded: batches are not vault-wide transactions, conflict copies require user judgment, retained remote versions expire after 30 days, and uncommitted browser text can still be destroyed by explicit sign-out or external browser-storage erasure. Notifications cannot make a provider's acceptance and the local delivery checkpoint one atomic transaction. The system does not promise exactly-once external alert delivery.

## 5. Sync threat model

| Dangerous outcome / sequence | Current protection | Remaining limit |
| --- | --- | --- |
| A and B edit offline; B uploads stale text after A | Conditional remote publication, common-base merge, visible retained alternatives | Conflicting semantics still need review; not a collaborative character-level editor |
| A edits while B deletes, or deletes while B edits | Revision-aware classification favors edits; delete consumes the exact incarnation | Preserved content can intentionally reappear at the original path with a conflict explanation |
| Delete then recreate identical bytes; an old device later deletes | New revision distinguishes incarnation even when the hash is equal | Intentional current deletion remains authorized |
| Directory listing/stat fails and looks empty | Incomplete discovery aborts; send-time absence is rechecked | Availability degrades until storage recovers |
| Download races a local edit/recreation | Current-byte checks and atomic text callbacks defer/rebase; binary copies preserve originals | Host/filesystem suspension requires physical acceptance |
| Connection switches while old checkpoint save completes | Stop/await old runtime; authority-bound generations; verified recovery copies | Directly editing stored authority by hand bypasses the supported transition |
| Reorder encounters a pasted duplicate ID | Mutation-time ownership and Markdown block conservation reject ambiguity | User must resolve genuinely ambiguous source ownership |
| Move stops after one file changes | Durable plugin journal before writes; recovery before ID normalization; guarded backend two-file publication | Ambiguous recovery preserves both copies and blocks affected edits |
| PWA session expires after an uncertain save | Scoped recovery retains exact intent; renewed authority requires review | Explicit logout intentionally clears private browser data |
| Request commits but its response disappears | Receipts and immutable staged objects survive; exact retry confirms the result | Commands past the bounded retry horizon need manual comparison/export |
| Old request arrives after receipt pruning | Protocol/date guard plus transaction-time monotonic floor rejects it | Historical in-place downgrade or manual floor reset violates the contract |
| Invalid reminder metadata blocks generic sync | Opaque file publication succeeds; projection is quarantined and incomplete lists are visible | A malformed reminder cannot be scheduled until repaired |
| Stale tabs/date caches disagree with committed data | Revision-ordered cross-tab settlement, freshness guards and shared minute/resume clock | No live push stream for every remote edit; normal refresh/resume remains relevant |
| R2/D1 outage or corrupt remote bytes | Prior pointers, retained objects, hash verification, local copies and paired archives | A backup is essential after retention expires; hosted restore is unverified |
| Attacker crosses a PWA folder/session boundary | Server-side scope/ownership checks, hashed credentials, revocation and delivery-time authorization | A full-vault device or compromised Cloudflare account has broad intended authority |

## 6. Architecture assessment

The division of responsibility fits a self-hosted single-vault system: Obsidian owns filesystem integration and planning; shared modules own domain transformations and contracts; the Worker owns authorization and publication; D1 owns authoritative metadata/receipts; R2 owns immutable bytes; Durable Objects own scheduling; the PWA owns private read caches and durable pending intent.

The practical abstractions added during remediation encode demonstrated invariants: scan completeness, checkpoint authority, source ownership, move recovery, scoped session recovery and receipt expiry. They avoid client-specific reinterpretations of the same operation. Core mutation/state-machine logic should remain reviewable as cohesive transitions; splitting files merely for line count or introducing a CRDT would not address a remaining reproduced defect.

The D1 primary and notification coordinator are throughput/availability concentration points. This is an acceptable initial deployment model, but larger hosted workloads need measurements. The new reminder-pane reservation is intentionally workspace-scoped across module reload: one pane and one pending activation, attachment/type checked before reuse, pending promise cleared afterward. It is a bounded host lifecycle workaround supported by a real reproduction, not a second persistent data store.

## 7. Cloudflare/backend assessment

The stage-then-publish design matches the relevant platform boundaries: D1 batches provide transaction rollback on a failed statement; R2 provides strong consistency but cannot participate in the SQL transaction. Crate retains staged objects across uncertain outcomes and garbage-collects only after checking current and retained references. These platform premises were rechecked against [D1 documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/) and [R2 consistency documentation](https://developers.cloudflare.com/r2/reference/consistency/).

Publication now enforces a portable hierarchical namespace inside D1, including case/Unicode aliases and file/parent collisions. It does not rely solely on a client preflight. General files retain opaque bytes even when reminder projection fails. Parser upgrades invalidate disposable caches and rebuild durable notification authority before previously queued/installed jobs may deliver. Existing first-observation timestamps survive migration, preventing old notes from becoming new alerts.

Current formats are **protocol 6, D1 schema 4, parser 7 and browser read cache 2**. Schemas 2/3 upgrade additively; unsupported schemas stop. Missing, older and future write protocols are rejected before mutation. Deployment ownership coordinates current updaters, reset and deletion, retaining uncertain ownership for recovery. Older updaters and direct dashboard administrators must be quiescent because they do not honor that fence. Rollback requires an isolated matching archive/build, not a marker downgrade; see [compatibility](compatibility.md).

File, batch, indexing, subscription and maintenance budgets are bounded. They establish application limits, not a guarantee about every Cloudflare account's CPU/quota behavior. The remaining operational test must measure Worker errors/CPU, D1 work, R2 traffic and projection delay on the intended plan. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

No additional queue, KV store or socket layer is needed for the initial release. Provider outages still reduce availability, and external notification delivery remains a best-effort boundary even when internal scheduling is correct.

## 8. Obsidian plugin assessment

The small entry shell delegates lifecycle, sync and reminders. Registered events, timers and abort generations prevent most unload/reconfiguration leaks. Atomic text processing checks the current document inside the mutation callback, so a stale index cannot authorize deleting/replacing new Markdown. Current-source ownership and the move journal protect project changes across watcher order and interrupted writes. The safe absence contract and rotating byte verification cover hidden files and equal filesystem fingerprints.

Actual host testing found R06 after the mocked lifecycle suite had passed. The final implementation was installed in an isolated Obsidian 1.13.7 vault and exercised through both the real repository/Vault APIs and visible editor controls. The exact `main.js` used for the final reload/editor checks matches the final release build. Commands remained at ten; pane identity remained stable; edited and completed reminder records survived reload. This is meaningful host evidence, while remaining narrower than a long-running sync or third-party-plugin compatibility exercise.

Binary review copies, local trash and explicit incomplete/conflict states are intentional safety features. Real mobile file adapters, suspend/resume, another plugin writing concurrently, and the declared minimum Obsidian version still need E02. Long-running in-flight Obsidian network requests cannot always be physically cancelled; lifecycle fences prevent their late results from initiating new local work.

## 9. PWA assessment

The application is offline-readable and durably retries changes initiated while connected. Starting a new mutation from offline cached mode remains disabled and documented. Sending resumes while the application is open and connected; no guarantee is made that an OS-killed application continues background synchronization.

Private snapshots, pending commands and editor drafts have separate recovery policies. Cache-only rebuild preserves pending intent and unknown future formats. Damaged queue entries and drafts remain exact, exportable strings; healthy queue entries can still proceed. Reviewed removal checks scope and current bytes, including cross-tab races. Involuntary auth expiry hides protected views but retains scoped recovery data; explicit sign-out clears it across tabs and fences late rehydration.

The service worker caches the generic shell/versioned assets rather than authenticated reminder API responses. Update acceptance precaches the target graph; older clients retain the assets they require. Browser tests cover stale workers, failed replacement links, session renewal, blocked/failed IndexedDB upgrades, quotas, corruption, lost responses and three-tab settlement. R05 lazily loads recovery controls while keeping normal editor focus synchronous; asset-load failure exposes a reload action while preserving saved intent.

Shared domain code covers recurrence, all-day/timed dates, DST, stored timezone, exact completion counts and reopening the displayed occurrence. Parser 7 keeps durable schedule decoding deterministic and protects Markdown links. Minute/deadline/resume clocks refresh time-dependent lists and reset timezone caches. Notification status requires current browser permission/keys and confirmed server registration; registration failures cannot falsely display enabled.

Actual installed iOS/Android behavior remains unverified. In particular, iOS/iPadOS Web Push requires the appropriate Home Screen app and a permission request associated with user interaction; desktop WebKit runs do not substitute for that device path. [WebKit platform requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## 10. Security assessment

No auth bypass, cross-folder data exposure, unsafe SQL interpolation, remote code execution or committed credential was confirmed in the reviewed paths. The final advisory audit reports zero known vulnerabilities; pinned Gitleaks 8.30.1 scans all **500 commits** through the code candidate and current source without leaks. This is a bounded audit result, not a guarantee against undiscovered vulnerabilities.

Server-side scope and ownership checks protect PWA operations independently of client UI. Full-vault devices intentionally have wider authority. Enrollment/session revocation, public rate limits, owner subscription limits, allowlisted push destinations, redirect refusal and delivery deadlines have actual Worker regressions. Untrusted title/draft text is tested as inert content. Authenticated API responses are excluded from service-worker caching, while private IndexedDB/local storage are explicitly disclosed.

Crate does **not** end-to-end encrypt vault contents from the Cloudflare account/Worker; the README states this. A compromised device, browser profile or hosting account is therefore outside the protection offered by a scoped web session. Pending local text also cannot survive a user or browser externally clearing all storage. Archives contain private data and keys and must not be attached to public issues.

**E04 — MEDIUM, confirmed repository configuration risk.** Live GitHub reads show private vulnerability reporting enabled, but `master` is unprotected, branch rules are empty, and repository secret scanning/push protection and Dependabot security updates are disabled. A mistaken privileged push can therefore bypass the intended pre-merge checks. The root cause is repository configuration, not a source-code auth defect. The [workflows](../.github/workflows/) already pin actions, use restricted token permissions, avoid persisted checkout credentials and require local security checks; weekly dependency proposals are configured. Before normal release maintenance, enable required checks/review and available security controls, then verify a failing change is rejected. Current settings are preserved in the evidence; this audit did not change remote repository policy.

## 11. Missing test matrix

“Protected” below means the named bounded scenario has a regression at the indicated seam. It does not mean all possible distributed histories or real-device transitions are proven.

| Scenario | Protection / evidence | Adequacy and remaining gap |
| --- | --- | --- |
| A edits / B edits | Shared classifier/merge plus three restarted actual engines | Protected locally, including overlapping alternatives and non-overlapping merge |
| A edits / B deletes; A deletes / B edits | State-machine permutations, transfer race tests and expired-history engines | Protected locally; both arrival orders preserve edited content |
| A renames / B edits | `sync-engine.integration.ts` preserves renamed and original-path edits | Protected locally; multiple paths are an intentional outcome |
| A renames / B renames | `sync-engine-history.integration.ts`, both orders | Protected locally; both destinations retained |
| Delete / recreate, including identical bytes | Incarnation revision and stale third-device deletion tests | Protected locally |
| Three-device concurrency | Three seeded histories, twelve rounds each, varying order/restarts/lost responses | Strong bounded corpus; no exhaustive model checking |
| Plugin / stale PWA update | `reminder-mutations.integration.ts` rejects stale whole-form writes | Protected with production Worker and committed Markdown |
| Weeks offline / expired history | Persisted local bases; cursor/version expiry engine tests | Protected locally; intentionally expired web commands require review |
| Network failure before/during a request | Transport failure, staged-write failure and retry tests | Protected at local seams; hosted network/latency soak absent |
| Response lost after server commits | `commit-safety`, `sync-full-upload`, `sync-recovery` and reminder mutation integrations | Protected with real local D1/R2 commits and injected lost acknowledgements |
| Duplicate requests / operation-ID misuse | Receipt/body hash tests for create/edit/complete/delete/move | Protected locally, including finite recurrence |
| Out-of-order requests | Stale hash/revision and per-operation receipt tests; PWA stale-read settlement | Protected for enumerated schedules |
| Client stops during transfer/checkpoint | Main/tmp generation recovery, lifecycle abort/restart and engine histories | Protected locally; actual OS process kill on mobile absent |
| Plugin stops during two-file move | Journal failure tests at source/destination boundaries | Protected with real writer/index logic; filesystem seam mocked |
| Backend commit response fails | Actual D1 transaction followed by injected response failure | Protected locally; hosted outage not exercised |
| Local scan/metadata corruption | Discovery, checkpoint authority and byte-verification tests | Protected locally; hardware corruption still needs independent backups |
| Browser cache/outbox/draft corruption | Unit validation and native Chromium/WebKit recovery scripts | Protected for blocked upgrades, malformed fields, quotas and changed export bytes |
| Migration failure / unsupported format | Real D1 schema retry, 22 archive tests, native IndexedDB upgrade tests | Protected locally; live upgrade/restore remains E01 |
| Old client / new backend, and future protocol | `protocol-compatibility.integration.ts`, cache/parser migration tests | Writes rejected before side effects; authentic reads remain at HTTP layer |
| Multiple PWA tabs | Native Web Locks, three-tab confirmation, missed signals and storage races | Protected in Chromium/WebKit; installed multiwindow device path absent |
| Service-worker version mismatch | Built-PWA install/update and asset failure scripts | Protected locally; exact hosted rollout remains E03 |
| Recurrence/DST/timezone/late completion | Shared domain tests, actual Worker mutation/migration and browser clocks | Protected locally; scheduled physical provider delivery absent |
| Push authority, revocation and registration repair | Worker delivery/security tests plus browser confirmation failures | Server/browser state protected; provider delivery is mocked |
| Obsidian editor/reload/pane lifecycle | Real 1.13.7 disposable-vault smoke plus 41 focused lifecycle tests | Verified desktop subset; minimum/mobile hosts remain E02 |
| 1k/10k notes and reminders; 25 MiB boundary | Actual engine/Worker capacity, binary boundary and browser pagination | Local scale protected; hosted CPU/cost and mobile memory not established |
| Independent-account disaster recovery | Automated paired-archive verification and interrupted restore fixtures | Missing hosted rehearsal; E01 remains open |

Primary regression files are under [sync tests](../src/sync/), [Worker integrations](../src/cloudflare/worker/), [reminder data tests](../src/reminders/data/) and [browser scripts](../scripts/). Full suite output is retained rather than inferring protection from coverage percentages.

## 12. UI/UX assessment

The repaired UI distinguishes incomplete reminder sources, pending/uncertain saves, rejected operations, expired commands, damaged local records, disconnected sessions and connectivity errors. A failed background check no longer leaves an old successful sync as the only visible state. Exact export and checked removal provide a recovery path without instructing users to clear all storage. Cross-tab confirmation prevents a successful operation from vanishing when another tab refreshes stale data.

Keyboard activation reaches sync activity and reminder editing; editor focus, composition, paste, undo/redo and pagination focus have browser regressions. The 48 visual cases cover shared editor/pickers in light/dark themes at phone/desktop widths. Actual Obsidian keyboard editing passed. This does not establish a comprehensive screen-reader audit or compatibility with every community theme.

Remaining UX tradeoffs are explicit: conflict copies and ambiguous moves require review; offline browsing cannot start new writes; reopening recurrence acts on the displayed occurrence rather than exposing a complete completion-history editor. A continuously visible app is not a real-time remote collaboration stream. These limits are documented and protected by revision checks, but physical-device acceptance should assess whether the messages make the next action understandable.

## 13. Performance/scalability assessment

R04 removes a confirmed round-trip bottleneck. For 1k/10k roughly 1 KiB notes across nested folders, actual engine-to-local-Worker cold uploads require **674 / 6,722 requests**, down from **2,002 / 20,002**. Every final local byte/hash and remote manifest is checked after offline edits, deletes, renames and restart. Measured R04 upload times were 1.98 / 19.63 seconds on that local run; these are not hosted latency promises. The 10k run still prepares about 90k SQL statements and writes one R2 object per note. Batching reduces round trips without removing linear backend work. [Workload and measurements](sync-capacity.md).

The final browser gate renders 200 reminder cards per page for 10,000 reminders, with all pages reachable. Its 10k fixture transfers approximately 2.31 MB of JSON; local first-list timings were 224 ms Chromium / 318 ms WebKit, with saves about 1.22 / 1.90 seconds. Pagination bounds DOM work, not the entire snapshot's network or memory cost. Shared clocks and viewport batching avoid per-card timers and unnecessary updates.

The 25 MiB file boundary is exercised with an exact binary round trip, a one-byte-over rejection before R2 writes, and a failed stage preserving old data. Reminder indexing has a separate 1 MiB source limit and bounded warming. Large source/parse failures remain visible rather than masquerading as an empty complete list.

Final Node 24.0.0 budgets pass:

| Artifact | Raw | Gzip |
| --- | --- | --- |
| Plugin | 1,404.85 KiB | 771.15 KiB |
| Styles | 136.83 KiB | 18.66 KiB |
| Worker including web assets | 1,269.91 KiB | 572.65 KiB |
| PWA entry | 94.90 KiB | 30.42 KiB |
| PWA startup dependency graph | 435.91 KiB | 148.38 KiB |
| All PWA scripts | 470.00 KiB | 161.03 KiB |

R05 retains the 450,000-byte startup raw limit while revising startup gzip to 154,000 and total raw/gzip to 485,000/168,000 bytes. Startup controls were deferred and missing lazy assets now fail recoverably. Headroom remains modest; future features should carry an explicit size review rather than silently raise limits.

Receipt/identity/occurrence cleanup is bounded and protected against replay after expiry. Remaining scaling risks are high-latency cold upload, full snapshot costs, long directories/history, simultaneous source migration and hosted quotas. Measure those on the intended account and physical devices before claiming a supported maximum vault size.

## 14. Open-source readiness

The repository has a 0BSD license, generated dependency notices, contributor/security guidance, issue/PR templates, architecture/protocol documents, explicit privacy/limits, deployment instructions, recovery tooling and an exact-artifact release checklist. A contributor can follow the source split and run `npm ci` plus the documented gates. Build outputs remain ignored and are not committed as release artifacts.

Dependencies are lockfile-resolved and a clean install succeeds on all declared Node baselines. Vite, esbuild, TypeScript, Obsidian definitions and local Worker/browser tools build reproducibly. The final advisory scan is clean. Actions are SHA-pinned, permissions are bounded, and the release workflow verifies the manifest tag, checks all three runtimes, compares artifacts, generates provenance and stops at a draft. The notices check passes; an automated notices file is useful evidence rather than a separate legal opinion on every transitive package.

Hosted CI/scanner/draft execution and repository controls remain E03/E04. Local reproducibility uses a clean Git archive and a fresh `npm ci` for each version; full test execution was on Node 24.0.0, so it must not be described as the hosted three-runtime test matrix passing.

Supportability is substantially improved. Background sync results persist in local history; reviewable diagnostics whitelist counts, timestamps and opaque request/session/operation IDs while excluding note names/content and secrets. D1 deletion receipts retain original actor/request, consumed/new revisions and sequence for 30 days. A “Crate deleted my note” report can now be correlated with the original delete rather than an unrelated retry. The [support guide](sync-diagnostics.md) and [recovery runbook](recovery.md) explain how to preserve local checkpoints, conflict copies and paired remote archives without publishing private data. Investigation beyond retention still requires the user's independent backups.

## 15. Recommended release plan

**Must complete before public release**

1. Preserve `bb14136` and its checksums as the candidate; keep current vaults/backups intact. Complete E01's unrelated-account deployment, update and paired restore rehearsal.
2. Complete E02 on the minimum Obsidian version and physical iOS/Android, including installed PWA push, background/resume and conflicts. Record actual host versions and the tested artifact hashes.
3. Push the reviewed commits when authorized, run E03's hosted matrix/community scanner, and compare the draft-release assets against the acceptance record. Resolve any failures before publication.

**Should complete before release**

1. Enable and verify GitHub required checks/review and available secret/dependency security controls (E04).
2. Run the largest intended hosted vault/reminder workload, recording CPU/errors, request latency, storage/query work and physical-device responsiveness.
3. Have another person follow the recovery/conflict instructions with non-critical data, especially uncertain saves and expired browser changes.

**Can follow after release**

1. Extend seeded multi-device histories with additional failure schedules and longer soak runs.
2. Improve large-folder snapshot delivery and cold-sync efficiency if hosted measurements justify it.
3. Expand screen-reader/community-theme coverage and notification-provider/device combinations.
4. Refactor large modules only where a new ownership or shared-invariant need is demonstrated.

No new feature or architecture rewrite is required to close the known code findings. The remaining release work is proving the candidate on its advertised environments and shipping the exact verified assets.

## 16. Highest-value improvements

With the implemented fixes in place, the five actions with the highest remaining risk reduction are:

1. **Independent-account backup/restore rehearsal:** proves the escape route for a serious sync incident.
2. **Physical iOS/Android sync and installed push acceptance:** probes OS lifecycle and provider boundaries local simulation cannot cover.
3. **Minimum-version Obsidian acceptance:** verifies the actual public compatibility claim using the exact assets.
4. **Hosted largest-vault and interrupted-update run:** checks resource limits, deployment ownership and migration recovery under real latency.
5. **Enforced release chain:** required GitHub checks, security controls, community scanning and checksum-matched draft assets prevent bypassing the established engineering gate.

## 17. Release-readiness score

These are approximate engineering judgments about evidence and residual risk, not measurements or a prediction of defect probability. Their simple average is 87.

| Area | Score | Principal remaining limitation |
| --- | --- | --- |
| Architecture | 88 | Concentrated per-vault authority; state-machine complexity requires continued boundary testing |
| Sync correctness | 91 | Strong local concurrency/failure corpus; no exhaustive histories or hosted soak |
| Data safety | 91 | Reproduced loss paths fixed; independent hosted restoration still unproven |
| Backend reliability | 83 | Local D1/R2/DO evidence cannot establish account quotas and provider outages |
| Obsidian plugin | 86 | Real desktop smoke passes; minimum and mobile hosts unverified |
| PWA | 84 | Native browser recovery/update coverage is strong; installed-device delivery/lifecycle absent |
| Security | 90 | Clean scans and tested boundaries; repository controls and account/device trust remain |
| Testing | 88 | Broad actual-module/runtime coverage; exact hosted/physical acceptance incomplete |
| UI/UX | 84 | Actionable recovery and keyboard coverage; theme/screen-reader/device breadth limited |
| Open-source readiness | 85 | Documentation and local artifacts ready; hosted release chain and controls outstanding |

**Would I personally approve this repository for public release today? No.** I would approve this candidate for controlled testing with backed-up, non-critical vaults. Public plugin approval follows the recorded E01–E03 acceptance checks, with E04 strongly recommended before routine maintenance. This decision reflects missing platform/operational evidence, not an unresolved known blocker in the repaired code.
