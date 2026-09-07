# Re-audit remediation — 6 September 2026

This implements the eight findings in the re-audit of `96f9469234481c8bc2798b393929f287b6b04cbc`. The earlier audit documents describe that historical candidate and remain unchanged. This document records the fixes and their verification, not another complete engineering audit or a production release certification.

| Finding | Implemented behavior | Regression evidence |
|---|---|---|
| R01: unsafe local deletion | Remote deletions force vault-local trash. Bytes written after the preflight hash remain recoverable; trash errors never fall back to permanent deletion. `.trash` is always excluded from sync. | Visible/hidden text and binary cases, permanent-delete preference bypass, trash failure, lost move acknowledgement and retry. |
| R02: logout cancels revocation | Only a revocation started while the session is valid may dispatch after local invalidation, using its captured credential. Other old-session writes remain fenced. The signed-out screen shows remote-cleanup failure guidance. | Real API wrapper plus real Worker/D1: DELETE dispatched, owned subscription removed, old token returns 401. Chromium/WebKit assert dispatch and cross-tab local clearing. |
| R03: stale projection/outbox handoff | Projections store their expected notification token and policy revision. Alarm delivery requires the current file, policy and notification intent to match. | Completion and title changes between projection and outbox application cannot deliver the old payload; the new command delivers the current title. |
| R04: accepted schedule replay | Outbox identity remains stable in the alarm. A completed occurrence survives cleanup/restart, and same-occurrence rescheduling preserves recipient progress. Delivery callbacks are serialized. | Same-job replay after successful delivery/restart produces one push; reprojecting during delivery preserves completion. |
| R05: edited ambiguous save | The exact attempted command is persisted separately from the draft. Retry resolves it before submitting later edits under a fresh operation ID and acknowledged revision. Definite validation errors permit correction. Scoped receipt reconciliation supports older drafts. | Failed-save edit/reload/retry, corrected rejection, legacy receipt recovery, and real D1 tests preventing receipt disclosure outside the requested folder. |
| R06: unowned legacy recipients | Migration 0009 disables unowned subscriptions. Shared recipient selection checks live owner/session/folder authority at send time; explicit push-only enrollment remains valid. Paused devices show reenrollment instructions. | Previous-schema migration plus live, expired, unrelated-folder, forged-folder, unowned and explicit-enrollment selection before/after maintenance. |
| R07: invisible exhausted delivery | Terminal failures persist in D1 before alarms stop. Diagnostics expose failure counts and oldest failure/overdue timestamps; the plugin reports failed health with repair guidance. | Actual alarm exhaustion and diagnostics; same-job replay/restart retains the failure; client diagnostics report failure. |
| R08: recovery cannot resume | Pacing, bounded retries and Retry-After handling accompany atomic source/archive/destination checkpoints. Resume verifies existing bytes and deterministic SQL, retains export identity, and polls accepted imports without re-ingesting. | Rate limiting, pagination, interrupted backup, lost upload/import acknowledgement, rejected unrelated/changed targets, resumed import polling and refusal to repeat an unconfirmed ingest. |

Committed as `e9b72e0c860c5cef7634ff83464d5a93487540c4` on local `master`: `fix: resolve remaining prerelease audit findings`. Not pushed. The implementation, regression tests, migration and operating guides are committed; audit reports and evidence remain local.

## Verification

- Full `npm run release:check` passed on Node 24.19.0: lint, plugin/Worker types, dead-code check, third-party notices, 1,024 unit tests in 178 files, 53 local Cloudflare runtime tests in eight files, 16 Python recovery tests, preview smoke, production build, CSS isolation, bundle budgets, release artifacts, and Chromium/WebKit cache/focus/performance/safety checks.
- Recovery tests passed again after restoring bounded CLI progress output.
- Visual TypeScript check and all 48 visual tests passed against the existing baselines.
- `npm audit` reported zero vulnerabilities, including development dependencies.
- Gitleaks 8.30.1 reported no findings in 434 locally available commits or current source.
- Existing bundle budgets were preserved. PWA startup gzip is 129.65 KiB against 129.88 KiB; little headroom remains.

Logs are in `docs/audit-evidence/2026-09-06-reaudit-remediation/`. No production deployment, push delivery, external account mutation or remote publication was performed.

## Upgrade and operational limits

Apply migration `0009_delivery_integrity.sql` through the server update flow before the matching Worker runs. It queues existing Markdown for projection and disables legacy subscriptions without identifiable owners. Remove paused notification devices in Obsidian, sign out in their web apps, and enroll them again through fresh links. Repair enrollment/provider access before rescheduling missed reminders to future times.

Local trash preserves the host-removed bytes; recovering a concurrent edit still requires reviewing that copy. A completed-occurrence receipt prevents replay of known accepted delivery but cannot prove exactly-once delivery when a push provider loses its acknowledgement. An import whose dispatch is uncertain and whose database remains empty is held for later verification, never blindly repeated; the recovery guide describes using fresh isolated resources if it cannot be confirmed.

Physical Obsidian desktop/iOS/Android interleavings, real push, independent-account deployment/OAuth, hosted paired restore, load capacity and hosted release CI remain unverified. These local results close the eight reproduced implementation defects within the tested boundaries; those external release checks remain necessary.
