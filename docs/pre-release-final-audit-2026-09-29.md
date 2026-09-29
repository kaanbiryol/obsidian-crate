# Final pre-release engineering audit — 29 September 2026

This reassesses the working tree based on commit
`226e72e262532eec7bde02e52828652c5354ab81`, including the fixes in
[the first follow-up](pre-release-fixes-2026-09-29.md). It supersedes the release
recommendation in the [original audit](pre-release-audit-2026-09-29.md), which
remains useful as a record of the original failures. Changes are uncommitted;
this audit does not publish or deploy anything.

Physical-device and native Obsidian acceptance are assigned to the maintainer,
as requested. Browser engines, simulated Obsidian filesystems and local workerd
are explicitly distinguished from those checks.

## 1. Executive summary

The system now has substantially stronger data-safety evidence than the original
candidate. Its core design is appropriate for a personal vault: the plugin owns
three-way reconciliation; immutable R2 objects hold bytes; conditional D1
transactions publish files, revisions, history and work for derived indexes;
the PWA changes Markdown through guarded domain mutations. Durable client intents
and server receipts bridge uncertain requests. There is no timestamp-wins policy.

This pass traced reconciliation, publication, reminders, notification scheduling,
client persistence, authentication/logout, service-worker updates and recovery
again. It found and fixed three additional client boundary problems: a delayed save
callback could submit another command, damaged Reading credentials prevented
logout from clearing private data, and stale cross-tab pending entries could
repeatedly replay an already settled command. Each received a failing regression before its fix.
A remaining contradictory schema paragraph was corrected too.

The earlier unexplained extra create request was reproduced with diagnostics.
It is an identical operation replay from the other WebKit tab, following delayed
visibility of a localStorage removal. It is distinct from the duplicate-save bug.
The outbox now remembers recent settlements to stop that feedback loop. The test
checks bounded immutable deliveries, one server effect, convergence in both tabs
and drained pending storage. An exact network-send count was not a valid
correctness invariant for an at-least-once system.

**Release position: conditional approval, subject to the acceptance items below.**
No unresolved BLOCKER or CRITICAL implementation defect was identified in this
pass. That is a bounded audit conclusion, not a guarantee that no defects remain.

## 2. Release blockers

The original loss/corruption findings F1–F3 are fixed with regressions. F4–F12 are
also addressed; see the follow-up for changes and original failing cases.

**R1 — deployment and native acceptance remains unverified.**

- **Severity:** HIGH. **Confidence:** Confirmed. **Classification:** Missing protection/test.
- **Area:** Release acceptance, host filesystem, deployment and disaster recovery.
- **Problem:** Local automation cannot verify the minimum Obsidian host, actual
  mobile filesystem/keyboard/suspension behavior, live OAuth/push, hosted resource
  limits or an independent Cloudflare-account restore.
- **Why it matters:** These are the remaining boundaries where a passing simulation
  can still differ from a user's installation.
- **Concrete failure scenario:** A simulated safe binary replacement passes, but a
  native host implements hidden-path creation/trash differently; or a successful
  local alarm test is followed by a push enrollment failure on installed iOS.
- **Relevant files/symbols:** `manifest.json` (`minAppVersion: 1.13.0`),
  `src/sync/local-recovery-write.ts`, `src/cloudflare/worker/notifications/reminder-alarm.ts`,
  `scripts/release-candidate.mjs`, `docs/testing.md`, `docs/recovery.md`.
- **Root cause:** Test environment coverage, not a newly demonstrated implementation defect.
- **Recommended change:** Complete and sign the [acceptance checklist](release-acceptance-2026-09-29.md)
  against the exact candidate. Keep hosted capacity claims bounded until measured.
- **Tests that prove closure:** Two real Obsidian vaults plus installed PWA; actual
  push while suspended and after permission changes; independent-resource restore
  with byte comparisons; hosted limits and OAuth checks. These are not marked passed here.

Do not publish a stable release with R1 silently treated as green. Source-only
publication can describe the candidate as awaiting this acceptance.

## 3. Critical/high-priority findings

### F13 — a delayed editor callback can create a second logical save (fixed)

- **Severity:** HIGH. **Confidence:** Confirmed at the editor callback boundary.
  **Classification:** Confirmed bug.
- **Area:** PWA reminder creation and submit lifecycle.
- **Problem:** The preparation guard ended when a command entered the durable
  outbox. A still-mounted editor could accept another callback using earlier props.
- **Why it matters:** The current-text snapshot is a copy of the modal. Issuing an
  epoch operation ID mutates that copy; another copied submission can receive a
  different ID, defeating server deduplication of the same user action.
- **Concrete failure sequence:** (1) Open a create editor with an unissued draft ID.
  (2) Submit; build the current-text snapshot and persist a command.
  (3) Preparation finishes and the sheet begins closing.
  (4) A delayed submit/keyboard callback retains submit-enabled props.
  (5) It builds another snapshot and can issue another identity for the same reminder.
- **Relevant files/symbols:** `ReminderEditorScreen.performSave`,
  `useReminderMutations.saveReminder`, `createSaveReminderChange`;
  `tests/editor-contract/reminder-draft-fixture.tsx` and `editor.spec.ts`.
- **Root cause:** A temporary preparation guard was used as if it represented the
  lifetime of an accepted editor submission.
- **Recommended change / implemented:** Latch submission in the editor until it
  unmounts after acceptance. The mutation action explicitly returns acceptance;
  validation or durable-storage failure releases the latch so the user can retry.
- **Tests that prove the fix:** In Chromium and WebKit, retain the editor after
  acceptance and deliver another submit. One callback is accepted. Also reject the
  first save, correct the draft, accept the retry, then reject a delayed third
  submission. All four cases failed before and pass after the fix. Existing current-
  text paste/submit and recovery tests remain. This deterministic boundary test
  does not establish that the original expiry failure was caused by double save.

### F14 — damaged Reading credentials prevent logout cleanup (fixed)

- **Severity:** MEDIUM. **Confidence:** Confirmed. **Classification:** Confirmed bug.
- **Area:** PWA privacy and recovery from corrupt persistence.
- **Problem:** `logoutReadingApp` read/validated stored credentials before entering
  any cleanup. A parse or access failure aborted the entire operation.
- **Why it matters:** A user selecting **Log out and clear device data** could leave
  credentials, private drafts, queued mutations and article data on that device.
- **Concrete failure sequence:** (1) Hydrate a Reading session. (2) Its stored
  credential JSON becomes unreadable while the tab remains open. (3) Select logout.
  (4) `readingSession()` throws before session invalidation or storage cleanup.
- **Relevant files/symbols:** `src/pwa/reading/logout.ts`, `readingSession`,
  `src/pwa/reading/App.tsx`, `src/pwa/components/SettingsSheet.tsx`.
- **Root cause:** Credential discovery was a prerequisite for local deletion.
- **Recommended change / implemented:** Read each credential independently, always
  fence in-flight work and attempt every cleanup, revoke whatever credentials were
  recovered, and report manual revocation when credentials could not be read.
- **Tests that prove the fix:** Unit failures for malformed JSON and unavailable
  reads; real UI reproduction preserving all four credential/draft/queue values
  on the old build; Chromium/WebKit checks that the fixed build clears those values
  and the actual Reading IndexedDB store. Other logout/storage tests still run.

### F15 — stale cross-tab entries repeatedly replay settled commands (fixed)

- **Severity:** MEDIUM. **Confidence:** Confirmed. **Classification:** Confirmed reliability bug.
- **Area:** Reminder outbox, WebKit cross-process storage visibility.
- **Problem:** Web Locks serialized drains, but the next tab could still read a
  pending entry that the previous tab had removed. Writing its new attempt count
  republished the stale entry. The tabs could repeatedly send the same receipt request.
- **Why it matters:** Idempotency protected server data, but repeated requests waste
  resources, can encounter rate limits, and can reapply an older response to the UI
  before its next refresh. Stress traces reached six sends for one new operation.
- **Concrete failure sequence:** (1) A sends and settles command X. (2) A removes X
  and releases the lock. (3) B acquires it before its storage view sees the removal,
  writes X with an incremented attempt, and replays X. (4) A receives that stale
  pending write before B's removal and replays X again. The body/identity stay exact.
- **Relevant files/symbols:** `createReminderOutbox.drain`, `useReminderOutbox`,
  `scripts/pwa-operation-expiry-test.mjs`, `src/pwa/reminder-outbox.test.ts`.
- **Root cause:** Removal visibility was treated as sufficient evidence that a
  completed command could no longer return to the current tab's queue.
- **Recommended change / implemented:** Remember 64 successfully persisted request
  fingerprints per outbox lifetime. An identical stale copy is removed without
  another send or state commit. Different bytes still reach server validation.
  Cache eviction/restart safely falls back to durable server receipts; fingerprints
  do not replace them and retain no note bodies. UTF-8 SHA-256 encoding is shared
  with existing enrollment/cache scopes, preserving their exact storage keys and
  the unchanged bundle budget without adding a startup network dependency.
- **Tests that prove the fix:** A deterministic two-tab storage-view simulation
  failed before the change; changed-body reuse is retained for review. Twenty
  Chromium and twenty WebKit scenarios passed afterward, including observed real
  replays bounded to one send per tab. The final browser test waits for settlement,
  checks at most two sends in this two-tab scenario, identical bytes, successful
  responses, one stored reminder, both tabs' cards, and empty pending storage.

**F7 follow-up (fixed):** `docs/protocol.md` still claimed schema 1 with no registered
migration despite the earlier documentation corrections. It now points to the
generated release contract and describes the registered 1 → 2 migration. Do not
maintain another independent copy of the schema/version table.

## 4. Sync correctness assessment

The actual lifecycle is:

1. Load an authority-bound, validated checkpoint and upload/restore journals.
   Unknown or damaged authority-bearing state stops sync; it is not treated as empty.
2. Recover dispatched operations by their original identities before preparing new
   ones. Initial import uses an unpublished import state; ordinary full sync reads
   paginated metadata and replays changes since the first page's sequence.
3. Compare local hash, current remote hash and last common hash in `classifyPath`.
   Both planners use this policy. A file's remote incarnation/revision is separate
   from its content hash, which matters for delete/recreate with identical bytes.
4. Prepare immutable bytes and durable intent before dispatch. The backend stages
   R2 bytes under unique keys, then publishes through conditional D1 mutations.
   File pointer, changelog, retained version, receipt and projection intent share
   the appropriate transaction.
5. Verify downloaded bytes and the planned local preimage before applying. Text
   writes use the host's atomic processing callback with current path/object
   identity. Existing binary updates become incoming review copies; explicit
   replacement preserves actual displaced bytes in local trash.
6. Persist acknowledged baselines/checkpoints before pruning completed journals.
   Failures leave retry/review state rather than reporting the whole pass as synced.

For concurrent independent Markdown edits, the cached common ancestor supports a
three-way merge. Competing frontmatter or same fenced-block changes are now kept
for review. Nonmergeable content is preserved in conflict/incoming copies.

Edit/delete resolves in favor of the edit and records that resolution. A rename
is a new-path publication plus a guarded old-path deletion, not a stable file-ID
rename operation. Concurrent rename/edit can retain the renamed copy and edited
original. Concurrent different renames can retain both destinations. These are
content-preserving outcomes, not semantic rename convergence.

Incremental cursors can expire; clients fall back to complete reconciliation.
Weeks offline fit the receipt window. After the supported 180-UTC-date operation
window, unresolved operations require review/export rather than a new identity
that might replay a previously committed action. Timestamps aid scheduling and
presentation; they do not choose the winning file content.

Important invariants and enforcement:

| Invariant | Enforcement |
| --- | --- |
| Do not publish a partial R2 write | Immutable staging, digest checks, D1 publication pointer and staging lease |
| Do not delete a recreated remote file | Hash **and revision** precondition in the delete transaction |
| Do not dispatch without recoverable intent | Client journal/outbox persistence before send |
| Same operation cannot mutate twice | Durable receipt plus request fingerprint, transactionally recorded |
| Local bytes cannot be overwritten using an obsolete plan | Atomic text/preimage guard; binary review, trash and non-overwriting create |
| Rename cannot delete its only remote copy first | Destination acknowledgement/checkpoint dependency before source deletion |
| One reminder ID has one source owner | Source index/occurrence checks and identity reservations; duplicate IDs fail closed |
| A notification must refer to the current committed source | Projection generations, job/schedule tokens and source authority checks |
| Cross-tab send count is exactly one | **Not guaranteed or required**; immutable requests and idempotent effects are required |
| Native filesystem semantics match the seam | **Requires maintainer acceptance**; not proved by simulated vault tests |

## 5. Sync threat model

| Threat | Current protection and remaining limit |
| --- | --- |
| Newer local edit overwritten by download | Preimage and current TFile identity checks; racing binary changes are preserved/reviewed |
| YAML metadata silently corrupted by merge | Competing frontmatter edits rejected as a whole; authored text preserved |
| Offline upload lost after a crash/lost response | Durable exact intent, server receipt and checkpoint ordering; damaged journals fail closed |
| Stale PWA overwrites plugin reminder edit | Reminder revision plus source-file conditional write; rejected draft retained |
| Duplicate reminder after retry | Same identity/body returns the receipt; F13 prevents a second accepted editor command |
| Repeated recurring completion advances twice | Receipt and expected revision; completion logic shared with plugin |
| Deleted content reappears | Unchanged stale copies are removed; edited copies intentionally survive delete/edit conflicts |
| Delete removes same-byte recreation | Remote revision distinguishes incarnations; stale delete rejected |
| Rename changes lose content | Destination-before-delete ordering; different renames can leave duplicates requiring review |
| PWA/Obsidian divergence | Markdown is authoritative; PWA projections are revision-bound and revalidated; asynchronous indexing can lag |
| Permanent loss of remote storage | Retained history and verified paired backups; history expires and is not an independent backup |
| Private data survives logout | Best-effort independent cleanup with explicit failures; F14 handles damaged credentials; browser policy can still deny deletion |
| Duplicate/missed push notification | Tokens and recipient progress reduce replay; provider acceptance and device display are not an exactly-once transaction |

## 6. Architecture assessment

The most valuable boundaries are already present: shared protocol/portable-path
validation, shared Markdown/reminder semantics, plugin-only reconciliation,
immutable content publication, and separate derived reminder/notification work.
Keeping these is more useful than replacing the system with a new sync engine.

The coordinator is an intentional serialization point for one deployment. Normal
file byte transfer prepares outside its short publication lock. The D1 transaction
is still the correctness boundary; a Durable Object does not make external R2/D1
operations automatically atomic. Reading extraction and notification projection
have bounded background work, but share some coordination/failure dependencies.

Two practical maintenance risks remain: route admission and authorization lists
must evolve together (contract tests protect this), and PWA/Reading persistence
have separate cleanup paths (F14 demonstrates the cost). Extend shared lifecycle
contracts and adversarial tests before a broad storage refactor. No new abstraction
is required just to reduce file length.

## 7. Cloudflare/backend assessment

The primitives fit the workload. D1 batches provide transaction rollback; R2
provides strongly consistent object reads/writes but no transaction with D1;
Crate's immutable staging and conditional publication correctly bridge that gap.
These conclusions match [D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
and [R2 consistency documentation](https://developers.cloudflare.com/r2/reference/consistency/).

The code explicitly serializes coordinator transitions across awaits rather than
assuming every Durable Object request is an indivisible critical section; compare
[Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/).
Authentication is checked at each request. Admission hints only select budgets;
they do not grant access. The edge rate-limit binding and bounded fallback are
abuse controls, not exact global accounting, consistent with
[Cloudflare's rate-limit scope](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Missing R2 bytes fail verification; failed D1 publication leaves leased staging for
safe cleanup. Queue/projection errors are durable and retryable. Changelog cleanup
failure now contributes to maintenance failure rather than being swallowed.
Backups restore paired D1/R2 state into isolated resources and preserve receipts;
restoring only D1 is insufficient. Hosted OAuth, resource budgets and restore remain
acceptance work, not inferred from local workerd success.

## 8. Obsidian plugin assessment

Lifecycle is owned by `CratePlugin` and focused runtime modules. Initialization and
settings writes are fenced by lifecycle signals; settings persistence is ordered.
Sync startup recovers journals before publication, and listeners/intervals have
cleanup paths. Tests exercise late responses after restart and event reentrancy.

The most consequential remaining host assumption is atomic filesystem behavior:
`Vault.process`, mutable TFile identity, non-overwriting creation, local trash and
hidden paths. The corrected seam now models renames and byte comparisons accurately,
but only real Obsidian acceptance can close this gap. The plugin remains mobile
compatible by manifest. Large scans and Markdown base caching are bounded/batched
where practical, but mobile memory and actual vault watcher traffic need measurement.

## 9. PWA assessment

The service worker caches the public shell and explicit assets, not authenticated
API responses. Content-hashed chunks and per-client version reports preserve assets
needed by older open clients. Unknown clients conservatively postpone cache cleanup.
Updates are gated on pending work and client readiness; incompatible writes fail
closed through protocol/capability checks.

Reminders use per-operation localStorage entries, IndexedDB confirmed snapshots and
sessionStorage drafts. Web Locks coordinate sending. The WebKit replay reproduced
here proves that locking application work does not make localStorage visibility
an exactly-once transport. Request receipts are the final safety boundary; the new bounded settlement memory
stops live tabs from repeatedly republishing an already settled entry.

Reading uses validated IndexedDB state, separate queue/drain locks, immutable
attempted requests, and bounded article cache retention. Unknown/damaged data are
preserved for review rather than silently cleared. Logout is explicitly destructive;
automatic session expiry preserves recoverable pending work.

The Reminders PWA is **not a promise of arbitrary offline editing**: cached browsing
is read-only while disconnected; already accepted changes persist and resume.
Reading supports its documented offline queue. No reliable browser background
execution is assumed. Installed iOS push, OS suspension and keyboard behavior are
still device acceptance items.

## 10. Security assessment

The security boundary is one self-hosted deployment/vault, with scoped reminder and
Reading credentials. This is not a multi-tenant SaaS schema: sharing one DB/bucket
between unrelated users would require a different isolation design. Folder-scoped
web sessions cannot use vault-administration endpoints. Server token hashes,
revocation and expiration are checked independently of rate-limit hints.

Path canonicalization rejects traversal and nonportable namespace collisions;
SQL values are bound. Reading HTML is sanitized, links are restricted, extraction
checks redirects/body sizes and uses public-network-only transport. Explicit bearer
authentication explains wildcard CORS; it is not cookie-based ambient write authority.
Private API responses use `private, no-store`. Shell caching does not contain vault
responses. Reading favicons and provider-visible plaintext are disclosed; this is
not end-to-end encrypted storage.

Dependency and secret checks are part of the final gate, including the packaged
server graph and fetched Git history. Actions are pinned to SHAs with separated
publication permissions. Lockfiles/shrinkwrap and generated license notices exist.
Install-time native/binary scripts remain part of the trusted build supply chain;
review their updates, particularly workerd/esbuild/Miniflare. Read-only GitHub API
checks confirmed private vulnerability reporting, vulnerability alerts, Dependabot
security updates, secret scanning and secret-scanning push protection are enabled.
The default `master` branch has neither branch protection nor repository rulesets;
see R3 below. No repository settings were changed.

## 11. Missing test matrix

“Covered” below means relevant automated behavior exists and is included in the
candidate checks; it does not mean physical-host acceptance has happened.

| Scenario | Current coverage | Remaining gap |
| --- | --- | --- |
| A edits / B edits | Real-engine disconnected merge/conflict, property tests, structural YAML/fence regressions | Native watcher timing |
| A edits / B deletes | Planner and multi-engine ordering tests; edited version survives | Real-host conflict messaging |
| A deletes / B edits | Both orderings and remote revision preconditions | Native trash behavior |
| A renames / B edits | Real engine, restarted checkpoint and mutable TFile seam | OS filesystem rename/events |
| A renames / B renames | Rename dependency/planner tests, preservation outcomes | Broader real-device timing matrix |
| Delete / recreate | Same-byte new revision and stale-delete replay tests | Host recreation race acceptance |
| Three-device concurrency | Independent engines; disconnected merges/frontmatter arrival orders | Physical three-device soak |
| Plugin / PWA concurrency | Real Worker revision/CAS and reminder mutation contracts | End-to-end native plugin + installed app |
| Weeks offline | Cursor expiry/full fallback, journal restart, operation-window tests | Long-lived installed app suspension |
| Network failure before request | Durable enqueue, retry/guard tests | Real radio transitions |
| Network failure during request | Interrupted uploads, partial batches, uncertain outbox | Real mobile interruption |
| Response lost after server commit | Receipt replay and crash recovery in real local bindings | Hosted interruption rehearsal |
| Duplicate requests | Exact receipts/body mismatch rejection; cross-tab replay observed and checked | Provider push display semantics |
| Out-of-order requests | CAS, operation fingerprints, job generations and stale authority tests | Long random distributed soak |
| Client crash during sync | Checkpoint/journal restarts, binary replacement interruption | Killing actual Obsidian process |
| Backend failure during sync | Injected D1/R2/transaction/publication failures, local server restart | Hosted outage recovery |
| Corrupt local persistence | Unknown/checksum-invalid checkpoint, queue quarantine, cache recovery, F14 logout | Browser eviction under real storage pressure |
| Migration failure | Transaction rollback, unsupported schema refusal, blocked/corrupt browser DB tests | Live hosted migration/rollback rehearsal |
| Old client / new backend | Protocol/capability tests, unknown formats and exact retained operation bodies | Historical released-binary matrix as releases accumulate |
| Multiple PWA tabs | Web Locks, storage/settlement races, offline recovery and expiry | More prolonged Safari soak |
| Service-worker mismatch | Native browser SW lifecycle, old chunks, pending-update guards | Installed iOS updates |
| Immediate editor save | Actual editor in document/Shadow DOM and PWA payload tests | Native keyboard Done behavior |
| Recurrence/DST/timezone | Shared calendar rules, repeated completion, sub-minute precision, timezone tests | Real timezone/notification changes |
| Logout with damaged credentials | Failing unit/UI reproductions; post-fix native browser storage checks | Browser storage policy can still require manual site cleanup |

Full runtime checks, browser gates and the final evidence manifest are recorded
below. No coverage percentage substitutes for these scenarios.

## 12. UI/UX assessment

The UI now distinguishes local files from incoming copies, retained drafts from
confirmed state, uncertain requests from rejected changes, and unresolved conflicts
from ordinary sync progress. Recoverable binary choices include their provenance.
PWA save reads committed editor text and cannot accept a second delayed submission.
Quota/validation failures keep the editor usable. Cleanup failures report a recovery
action rather than claiming unconditional logout success.

Phone/desktop browser checks exercise focus, semantics, empty/error/loading states,
touch targets, zoom and Shadow DOM styling. Native VoiceOver, software keyboards,
installation, OS edge gestures and suspension are not replaced by those tests.
Retain clear wording about edit-wins deletion races and manually reviewed attachments;
those are product semantics users need to understand.

## 13. Performance/scalability assessment

**R2 — supported hosted/mobile capacity is not yet established.**

- **Severity:** MEDIUM. **Confidence:** High. **Classification:** Architectural risk / missing measurement.
- **Area:** Large vaults, large reminder folders and deployment cost.
- **Problem:** Local 1,000/10,000-item tests verify completeness and bounded rendered
  rows, but the reminder API still transfers a full list and cold indexing takes
  multiple requests. A per-deployment coordinator serializes publication work.
- **Why it matters:** High latency, mobile memory, D1 request budgets and concurrent
  projection/extraction can make a correct system slow or appear stuck.
- **Concrete failure scenario:** A phone reconnects to a large cold reminder folder
  while another device imports thousands of notes; indexing waits, the full JSON
  snapshot is large, and UI counts lag even though bytes remain safe.
- **Relevant files/symbols:** `reminders-web/routes/list.ts`, `reminder-cache/warm.ts`,
  `coordinator-requests.ts`, `scripts/pwa-capacity-test.mjs`, `docs/testing.md`.
- **Root cause:** File-oriented authoritative storage with derived indexes and
  bounded background work; local benchmarks do not reproduce hosted budgets.
- **Recommended change:** Publish measured support limits, measure before introducing
  a per-reminder index/paginated contract, and keep existing payload/work budgets.
- **Tests that prove closure:** Hosted 1,000/10,000-note/reminder runs with CPU,
  rows-read, request failures, latency, response bytes and physical-device memory.

Manifest reads and file transfers are paginated/batched; file size is capped at
25 MiB. Journals, changelog/receipt retention and staged-object cleanup bound
ordinary growth. Retained history and intentionally preserved corrupt recovery
entries consume storage until handled. Old open clients can keep old shell caches
alive. Bundle budgets are close to their limits; do not increase limits merely to
make a release gate pass.

## 14. Open-source readiness

README, architecture/protocol documentation, license, contribution guidance,
security policy, issue templates, migration/recovery runbooks, pinned CI actions,
dependency automation and deterministic build checks are present. The generated
contract table removes several sources of stale version claims. The remaining
schema contradiction found in this pass is corrected.

For “Crate deleted my note,” existing support data are now useful: opaque revision,
request/device/client-session/operation IDs, consumed delete revision, retained
versions, local trash, durable journals and privacy-filtered diagnostic export.
The runbook correctly says to preserve device data before forcing sync or resetting
metadata. Server log retention and actual independent backups remain operational
responsibilities; diagnostics cannot recreate bytes after every copy has expired.
A privacy-safe missing-note drill belongs in maintainer acceptance.

**R3 — the default branch does not require CI before changes land.**

- **Severity:** MEDIUM. **Confidence:** Confirmed. **Classification:** Missing protection.
- **Area:** Repository governance and release provenance.
- **Problem:** GitHub reports `master` as unprotected and returns no repository or
  inherited rulesets, despite the repository containing substantial CI coverage.
- **Why it matters:** A direct push or merge can bypass the checks that establish
  sync, artifact and security safety before landing. The dedicated release workflow
  does require its verification jobs; that reduces publication risk but does not
  enforce the checks for changes landing on the default branch.
- **Concrete failure scenario:** A change to receipt persistence lands directly on
  `master`; users building the public branch consume it before its failing Worker
  job is noticed.
- **Relevant files/symbols:** `.github/workflows/`, GitHub default-branch settings;
  read-only evidence in `.generated/pre-release-final/github-*.json` and logs.
- **Root cause:** CI exists without repository-level enforcement.
- **Recommended change:** Configure a ruleset for `master` requiring the current
  aggregate `build` check from `lint.yml` and `secrets` from `security.yml`, plus
  review appropriate to the maintainer model. The aggregate already depends on
  all verification jobs, including native Linux AMD64/ARM64 Docker tests.
  These remote settings and publication were not changed by this local audit.
- **Tests that prove closure:** Query the configured ruleset, verify required check
  names against an actual PR run, and confirm a failing check blocks merging.

The working tree has not been committed. Candidate and comparison hashes identify
what was tested; the final release should pin a commit and preserve its CI evidence.

## 15. Recommended release plan

### Must fix before release

The demonstrated implementation fixes F1–F15 must remain in the release candidate.
Preserve the passing uninterrupted release gate and its frozen artifacts. Finish
R1's applicable native/hosted acceptance before publishing a stable release. Record failures honestly.

### Should fix before release

Enable required CI checks on `master` (R3); the security reporting/scanning settings
are already enabled. Rehearse a missing-note support case and paired restore using disposable resources.
Document a conservative supported size based on real hosted/mobile measurements.
Confirm that attachment-review and offline-editing limitations are clear in release
notes. Publish from an immutable commit with the required manifest/assets.

### Can safely follow after release

Add longer random three-client crash/partition soaks; expand old-binary compatibility
fixtures as releases accumulate; measure coordinator latency and optimize only
observed bottlenecks; consolidate duplicated cleanup contracts; add optional
privacy-safe operational alerts for maintenance and projection backlogs.

## 16. Highest-value improvements

If only five release tasks fit, prioritize:

1. Keep the guarded local replacement/rename/checkpoint fixes and their real-engine regressions.
2. Keep structural Markdown merge safeguards and shared reminder revision/idempotency contracts.
3. Keep immutable client commands, the accepted-save latch, and actual multi-tab/crash tests.
4. Complete real-host/device acceptance and an independent paired-backup restore.
5. Freeze a candidate that passes the complete security/build/runtime/browser gate,
   with diagnostic/recovery instructions and artifact hashes retained.

The first three and the automated part of the fifth are complete here; the remaining
acceptance record determines
whether this candidate can become a public stable release.

## 17. Release-readiness score

**87/100**, with the final automated gate passed.
This is engineering judgment, not a statistical probability of safety.

| Area | Score |
| --- | ---: |
| Architecture | 85 |
| Sync correctness | 90 |
| Data safety | 88 |
| Backend reliability | 85 |
| Obsidian plugin | 82 |
| PWA | 87 |
| Security | 89 |
| Testing | 90 |
| UI/UX | 83 |
| Open-source readiness | 90 |

The main deductions are unverified native/hosted acceptance, finite recovery
windows and backup dependence, limited historical-binary compatibility evidence,
and unmeasured hosted/mobile scale. Filesystem simulation and local workerd cannot
justify a score of 100.

**Would I personally approve this repository for public release today? Yes with
conditions.** The implementation can proceed to the maintainer's final acceptance;
I would approve stable publication after the applicable manual/hosted checklist is
signed and the release commit retains passing CI for this same candidate.

## Final automated evidence

`npm run release:check` completed **uninterrupted with exit code 0** in the
isolated checkout after a fresh `npm ci`, using Node **v26.8.2** and npm **11.19.1**.
The candidate was recorded at **2026-09-29 16:04:48 UTC**. No production service or
real vault was used for these tests.

| Check | Final result |
| --- | --- |
| Root and packaged-server npm advisory audits | 0 vulnerabilities in both graphs |
| Gitleaks | 925 commits plus current source; no findings |
| Lint, plugin/Worker types, dead code, notices, contracts and release metadata | Passed; two existing deprecation warnings, no lint errors |
| Unit tests | 3,821 passed in 366 files |
| Local D1/R2/Durable Object Worker integration | 580 passed in 69 files |
| Local server, pairing, tunnels and backup | 16 passed |
| Reading extraction / server / browser | 8 / 9 / 14 passed |
| Shared visual and keyboard tests | 355 passed |
| Editor contracts | 532 passed; 4 intentionally inapplicable plugin-host cases skipped |
| Activity, conflict review and file history | Passed in Chromium and WebKit |
| PWA browser gate | All 46 scripts passed |
| CSS scope, plugin/Worker/PWA sizes, artifact verification | Passed with unchanged budgets |
| Fresh packed-server npx install and restart | Passed; its Worker is byte-identical to the final artifact |

The tested release-input SHA-256 is:

```text
17bc6f56a878e6b9a9c283a3c0e6e50efbd1a03c505dc72a35404aa0c33bc2be
```

The 1,598 release inputs match the primary checkout. `source-comparison.json`
also compares the complete Git-visible trees, including tests, packaged-server
inputs and documents that are outside that release-input fingerprint. The complete
comparison contains **1,854 files with zero differences**, including this final
documentation-only update.

Evidence is in `.generated/pre-release-final/`: `final-release-check.log`,
`release-candidate.json`, `results.json`, `artifact-manifest.json`, the source
comparison and the earlier reproductions. `candidate-plugin/` contains the verified
`main.js`, `styles.css` and `manifest.json`; `crate-0.4.0-audit-candidate.zip`
contains those same three files. Worker/PWA/schema artifacts are retained under
`candidate-server/`. Use these frozen files for maintainer acceptance, since the
primary checkout has an existing development watcher.

No physical-device or native Obsidian result is claimed. Hosted OAuth/resource
limits/push, independent-account restore and Linux AMD64/ARM64 Docker CI remain
unverified; the local Docker daemon was unavailable. GitHub security reporting and
scanning settings were verified read-only, while required branch checks are still
absent (R3).

Verification also found a startup regression in an intermediate bundle-size change:
loading the sender on demand let the draft-recovery test's network fault interrupt
outbox initialization. That loading change was removed; the unchanged recovery test
passes with the sender back in the startup bundle. Shared SHA-256 encoding preserves
existing enrollment/cache/queue namespaces and keeps the original size limits.
Known UTF-8 digest vectors and 78 targeted persistence/outbox tests pass.

Settings stress runs exposed WebKit errors while the fixture reloaded a document
with Reading requests still active. The preference test now waits for those
requests to settle before its deliberate reloads. Error checks were retained and
an immediate post-focus retained-query assertion was added. Three full WebKit
settings repetitions passed. An earlier stress run also lost search text once;
its exact cause was not established separately, so these checks are evidence of
improved repeatability, not proof of every native navigation timing. The earlier
failed runs remain in the evidence directory. The real-Worker Reading browser
scenario had the same class of navigation race after enrollment: it replaced the
document as soon as the token existed, interrupting the initial Reminders list.
It now awaits that response and network settlement before navigating; both engines
pass the focused enrollment/offline/lost-response/logout scenario with all error
and revocation assertions retained.
