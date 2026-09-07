# Pre-release audit remediation

All 19 findings from the [6 September audit](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/pre-release-engineering-audit.md) received implementation fixes and passing targeted local regression checks. Those changes were committed as `96f9469`. The [subsequent comprehensive re-audit](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/pre-release-engineering-reaudit-96f9469.md) found eight remaining or newly exposed defects, including a local deletion blocker and incomplete session/notification guarantees. This record documents remediation progress, not release approval; the re-audit is the current assessment.

| Finding | Implemented fix | Regression evidence |
|---|---|---|
| F01 uncertain commit cleanup | Preserve uncertain staged bytes; share live/retained reference checks; verify same-payload retry content. | Real D1/R2 lost-response tests cover single, batch, Markdown, and paired writes; cleanup protects live and retained references. |
| F02 stale reminder writes | Capture semantic editor revisions; require server preconditions; compare fresh Markdown blocks inside atomic local writes. | Stale plugin form/index and Worker update/delete/completion tests reject conflicts while retaining drafts. |
| F03 local apply | Use atomic supported text updates; preserve incoming binaries for review; detect an edited incoming copy. | Local apply/conflict tests cover concurrent text edits, concurrent creation, binary replacement deferral, and retry copy preservation. |
| F04 time serialization | Persist UTC instants and recurrence zone/count/end/progress; preserve exact instants through unchanged minute controls. | Domain tests cover UTC/Tokyo/Honolulu, DST overlap, all-day calendar semantics, manual recurrence edits, and real form submission helpers. |
| F05 reminder retries | Commit operation receipts and permanent creation identities with file changes; retain stable local creation IDs. | Real Worker replay tests cover moved/deleted sources and recurring completion; local lost-write-acknowledgement retry creates one reminder. |
| F06 alarm interleaving | Fence every asynchronous transition by schedule token; condition outbox updates on job token. | Controlled overlapping delivery/replacement tests and real Durable Object tests preserve the newer schedule. |
| F07 schedule authority | Commit projection intent with files; derive schedules from committed bytes and server policy; use a bounded durable coordinator. | Real runtime tests cover sync writes, stale jobs/policies, delayed coordinator work, disabled policy, and legacy alarms without a valid projection. |
| F08 optimistic PWA state | Merge acknowledged per-record results into current state; fence pending operations and reorder. | Six hook tests plus Chromium/WebKit mutation and interaction checks pass. |
| F09 failed drafts | Await successful save before dismissing either editor; retain web drafts across reload. | Browser tests inject failed saves in both engines and verify the draft survives reload; modal/repository regression checks pass. |
| F10 logout | Fence requests and cache writes by session generation; invalidate other tabs; revoke owned subscriptions. | Chromium/WebKit checks cover open tabs, cache clearing, reload, and logout; real Worker ownership/revocation tests pass. |
| F11 deployment downgrade | Join existing deployments without upload; require explicit update intent; check authoritative remote version before migration. | Deployment discovery/service/provisioner tests cover older and unknown existing deployments and explicit updates. |
| F12 compatibility/migrations | Require protocol 3 writes; negotiate compatibility; fence retryable Unicode backfill; preserve caches needed by active PWA versions. | Protocol, deployment/migration, real Worker, and service-worker lifecycle tests pass. |
| F13 delete/recreate | Carry opaque file revisions through the full sync lifecycle and require the acknowledged revision on deletes. | Real same-content recreation test rejects an old delete; planner/manifest/transfer regressions pass. |
| F14 reminder indexing | Cache per-file issues and return the healthy remainder; bound source/cache sizes and web note growth. | Real runtime tests cover oversized notes and oversized parsed records; cache/index tests pass. |
| F15 release gates | Fix original failing fixtures; include Chromium/WebKit browser tests in release checks; separate build/publication permissions; refresh reviewed visual baselines. | Clean-install release gate passes; 48 visual checks pass on the documented macOS 26 baseline platform; Node 20/22/24 artifacts match. |
| F16 resource limits | Bound uploads, index warming, projection/outbox work, and cleanup; coalesce reconciliation; surface skipped oversized sync files. | Batch/query-boundary, index progress, coordinator, cleanup, and transfer error tests pass; all bundle budgets pass. |
| F17 scope/abuse | Bind web sessions to folders; enforce subscription ownership/caps; restrict providers; apply per-address/route rates and push deadlines. | Real D1 security tests cover scope, ownership, capacity, and rate-limit bypass attempts; push validation/deadline tests pass. |
| F18 operations/recovery | Add content-free correlation and queue diagnostics; provide paired D1/R2 backup, verification, and isolated restore tooling. | Five recovery tests verify paired bytes and database state, retries/identities, corrupt archives, malicious SQL, and unsafe targets; diagnostics checks pass. |
| F19 supply chain | Update vulnerable transitive packages; pin action revisions and scanner checksums; split workflow privileges; scan history and pending source. | Clean `npm ci`, zero-advisory `npm audit`, notices, and Gitleaks history/source scans pass. |

## Verification

[Captured commands, logs, and artifact hashes](audit-evidence/2026-09-06-remediation/README.md) distinguish these results from the original reproductions:

- `npm run release:check` passes after clean `npm ci` on Node 24.19.0: lint, plugin/Worker types, dead-code analysis, notices, five recovery tests, 1,013 unit tests in 177 files, and 42 real local Cloudflare tests in six files.
- The same command passes PWA preview smoke, production builds, CSS scoping, every size budget, release artifact validation, and cache/focus/performance/safety checks in Chromium and WebKit.
- Visual types pass. All 48 screenshot/layout/keyboard checks pass after reviewing and refreshing 40 stale images. Snapshot CI now uses the same macOS 26/Apple silicon platform; functional release CI remains on Linux.
- `main.js`, `styles.css`, and `manifest.json` are byte-identical across local Node 20.20.2, 22.23.2, and 24.19.0 builds. CI additionally checks the supported minimum versions.
- Dependency audit reports zero vulnerabilities. Gitleaks 8.30.1 reports no leaks in available Git history or current source using the narrowly scoped public OAuth client-ID exceptions.

## User-visible changes and upgrade requirements

Protocol 3 requires updated clients before writes. Use **Authorize update** to run the ordered migrations and fenced portable-path backfill; collision failures need explicit repair and retry. Connecting another device alone does not deploy code.

Existing binary files receive a preserved incoming server copy for conflict review when the host has no atomic replacement primitive. This retains intervening local edits. Supported text files continue through atomic comparison/update. Sync reports files over 25 MiB as errors; the web reminder index reports notes over 1 MiB as per-file issues while retaining the healthy list.

Notification folder, timezone, all-day time, and enabled state are shared server policy. Changing them requires an explicit settings action. Old unbound web sessions need a new enrollment link. Failed web saves remain available across reload, and competing reminder changes now surface a conflict instead of silently overwriting the newer content.

## External release checks

These local results do not substitute for physical iOS/Android Obsidian testing, an independent-account Cloudflare OAuth and real push test, a hosted paired-resource restore rehearsal, the community-directory scanner, or a successful hosted CI run on the final commit. Those environments were not exercised or deployed during remediation. Complete [the release checklist](release-checklist.md) against the exact artifacts before public release. The [recovery runbook](recovery.md) provides the backup and isolated-restore procedure.
