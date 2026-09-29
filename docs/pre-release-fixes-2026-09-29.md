# Pre-release fixes and second verification pass

Historical verification record. See the [final audit](pre-release-final-audit-2026-09-29.md) for the later findings, fixes, expiry replay diagnosis and final gate result.

This follows the [original audit](pre-release-audit-2026-09-29.md) of commit
`226e72e262532eec7bde02e52828652c5354ab81`. The original report is a historical
snapshot. The changes below are uncommitted working-tree changes; no release or
hosted deployment was performed for this task.

## Fixes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| F1 — recovery can lose intervening bytes | Recovery moves the actual displaced file to local trash and uses a non-overwriting host create, including hidden files. Recovery-copy creation uses the same safe create. A durable checkpoint precedes binary removal so interruption cannot become a remote deletion. | Late binary edits, hidden recreation, oversized text, checkpoint failure, failed creation, and a real engine restart between trash and creation. |
| F2 — invalid frontmatter published by auto-merge | Treat frontmatter as one authored unit and reject competing fenced-block edits. Preserve UTF-8 BOM and newline behavior. | Duplicate keys, nested mappings, anchors, competing insertions, deletion/addition, whitespace delimiters, both arrival orders, and real multi-device sync. Independent body edits still merge. |
| F3 — writes follow renamed TFiles | Verify both path and object identity inside the atomic text callback. The engine filesystem seam now preserves mutable TFile identity through rename. | Renames during reads and atomic processing, excluded destinations, and replacement objects with identical text. |
| F4 — pre-auth admission gaps | Reject unknown routes/methods cheaply; admit API reads and writes before D1/DO work; authenticate normal Reading routes before coordination. Key fallback state by the original binding. Use bounded credential-hash hints only to select a separate bulk budget, never to bypass authentication. | Denied reads touch neither D1 nor DOs, invalid rotating bearers share a budget, wrappers do not reset it, revocation remains immediate, bounded maps/expiry, and large-vault sync. |
| F5 — ineffective byte assertions | Install byte-aware equality in both Vitest runners, including nested/containment assertions and cross-realm buffers. | Deliberate changed/truncated/appended/reordered bytes fail, including workerd response buffers. All safety suites rerun with the matcher. |
| F6 — vulnerable dependency | Pin patched Undici 7.29.1 in Miniflare's graph and the packaged server. Audit both graphs in the security gate and add server Dependabot coverage. | Both npm audits clean; packaged server installs and preserves data across restart/URL changes. |
| F7 — contradictory current contracts | Correct migration, recovery, protocol, concurrency and batch documentation. Add a generated contract table and source-consistency gate. | `check:contracts`, server revision gate, recovery and migration tests. |
| F8 — incoming attachment provenance unclear | Document manual review for updates to existing binary files; distinguish local versus incoming server copies and provide **Use incoming copy → Apply choice**. | Chromium/WebKit at phone and desktop widths, with explicit selection and recovery explanation. |
| F9 — maintenance failures hidden | Let changelog cleanup errors reach the existing maintenance aggregator while other cleanup continues. | Injected D1 failure is persisted as `last_error`; unrelated cleanup still runs. |

No schema or wire-protocol change is required. Server revision 2 remains the
unpublished candidate selected by the repository's release policy.

## Additional issue found and fixed during verification

**F10 — keeping an incoming binary version loops back into review.** Severity:
**HIGH**. Confidence: **Confirmed**. Area: conflict resolution/checkpoint state.

1. A and B synchronize an attachment.
2. A changes it; B retains the old local attachment and saves A's incoming copy.
3. B selects **Keep local** or **Keep both**. The old implementation deletes the
   review copy and marks the conflict resolved, but leaves B's old baseline.
4. B's next sync again classifies the server version as an incoming change and
   recreates the same unresolved review. The apparent resolution does not stick.

Two real-engine regression tests failed before the fix. The cause was that
`markConflictResolved` changed review metadata without recording which remote
version the user had reviewed. The fix checks the current remote hash, persists
that reviewed baseline, and marks the retained local file pending. Publication
then follows the existing journaled upload and conditional-write protocol.
A changed server hash requires another review. A later server change is still a
conflict. Offline verification keeps the existing review and does not repeatedly
create keep-both files.

Relevant implementations: [engine.ts](../src/sync/engine.ts),
[conflict-review.ts](../src/sync/conflict-review.ts), and
[runtime.ts](../src/sync/runtime.ts). Tests in
[sync-engine.integration.ts](../src/cloudflare/worker/sync-engine.integration.ts)
cover both choices across restart and server edits before resolution/next sync;
[conflict-review.test.ts](../src/sync/conflict-review.test.ts) covers offline retry.

**F11 — the source gate requires artifacts that it has not built.** Severity:
**MEDIUM**. Confidence: **Confirmed**. Area: reproducible release checks.
On a fresh checkout, `release:check` reached Knip before the Worker build created
`build-identity.json`; loading the Vite configuration then failed. An already-built
developer checkout hid the prerequisite. `check:source` now builds the Worker
before its source checks. The isolated run starts from a fresh `npm ci`, which
tests this ordering as well as the rest of the candidate.

**F12 — immediate editor submission can save an earlier draft.** Severity:
**HIGH**. Confidence: **Confirmed**. Area: reminder editing/data integrity.
The broad editor run saved two timed recurring reminders without their times.
Forty targeted reruns passed, but a deterministic same-turn paste/submit test
reproduced the underlying boundary failure in Chromium and WebKit, in both
document and Shadow DOM hosts: type `Call Alex every Monday`, paste
` 09:00:30.123`, then submit before React publishes the new draft. The saved
rule was still the earlier all-day rule.

The editor now exposes a committed Markdown snapshot. Plugin and PWA save
actions read both fields from that snapshot. The PWA reconciles any newly read
title metadata before saving, and plugin submission no longer restores a removed
repeat rule from an effect that has not caught up. Regressions cover immediate
keyboard submission, repeat removal, pending description paste through the Save
button, and actual PWA request payloads. Link destinations and multiline text
remain Markdown, rather than being reconstructed from visible labels.

Relevant implementations: [RichTextInput.tsx](../src/reminders/components/RichTextInput.tsx),
[useReminderModalActions.ts](../src/reminders/ui/reminder-modal/useReminderModalActions.ts),
[reminderMutation.ts](../src/reminders/ui/reminder-modal/reminderMutation.ts), and
[ReminderEditorScreen.tsx](../src/pwa/components/ReminderEditorScreen.tsx).

## Verification

Verification uses an isolated checkout with the same patch and a fresh `npm ci`
on Node 26.8.2 / npm 11.19.1. A pre-existing development watcher in the original
workspace rewrites `dist/`; it interrupted the first visual-preview startup.
The isolated run avoids that shared build output without stopping the watcher.

| Check | Result |
| --- | --- |
| Root and packaged-server dependency audits | Zero reported vulnerabilities in both graphs. |
| Gitleaks | Current source and 925 commits passed. |
| Lint, plugin/Worker TypeScript, dead code, notices, contract documentation | Passed. Two existing deprecation warnings remain. |
| Unit tests after the final production change | 3,814 passed in 364 files. |
| Worker runtime with real local D1/R2/DO bindings | 580 passed in 69 files, including 1,000/10,000-note capacity scenarios. |
| Recovery tooling | 32 passed. |
| Local server | 16 passed. |
| Packaged-server installation/restart | Passed with the patched dependency graph. |
| CI helpers and server revision helpers | 17 passed in each group; revision gate passed. |
| Reading | Extraction 8 and server/shortcut 9 passed. Fourteen browser scenarios exercised; the failed highlight fixture was corrected and both engine variants rerun successfully. |
| Final production build, CSS scope, bundle budgets, artifact verification | Passed. |
| Final visual suite | 355 passed. |
| Final editor contracts | 528 passed across Chromium/WebKit and document/Shadow DOM hosts. |
| Activity, conflict review, file history | Passed in Chromium and WebKit. |
| PWA browser gate | All 46 scripts completed: 44 passed initially. The corrected settings script and the unchanged expiry script passed targeted reruns. The expiry event remains unexplained; see below. |

The release command was resumed by stage after failures were investigated;
there is no claim that one uninterrupted `release:check` invocation exited zero.
The additional editor fix was followed by fresh lint/type checks, all unit tests,
all editor contracts, a production build, and all visual tests.

Two browser fixtures had invalid readiness assumptions. Reading selection now
waits for a unique article revision instead of matching text also present in
the cached article. The compound-focus helper now blurs an already-filled field
before measuring its unfocused border. Both retain their original behavioral
assertions, and the corrected scenarios pass in both engines.

### Intermittent check still requiring investigation

One WebKit expiry run observed three create requests where its strict assertion
expected two. That run did not retain the extra request's operation ID, so it
does not establish whether this was an idempotent retry or a duplicate logical
save. The assertion was not weakened. A diagnostic run, ten repeated dual-engine
runs, and a final run of the unchanged script all passed. The original failure
and rerun logs are retained. The equally strict assertion now prints operation
IDs on failure; that version also passes both engines. Treat the cause as
unresolved; a passing rerun is not proof that the event cannot recur.

Final artifacts were reverified after all source edits, and server revision 2
passed against the release baseline with 145 changed server inputs. The recorded
candidate source SHA-256 is
`91c270e99a92ff02da6d5ae277014d065a43ddfe67f4f5b0ba21aa5776402fa9`.
A separate comparison covers 1,731 source, test, package and configuration
files with zero differences between the primary and isolated checkouts.
Local evidence is preserved in `.generated/pre-release-fixes/`, including the
original failures, final results, source hashes and candidate manifest.

## Release position after this round

All nine original findings have code or documentation fixes and regression
coverage. This round additionally fixed the binary-resolution loop, clean-build
prerequisite, and immediate-save race. I would not give unconditional release
approval yet: investigate the unexplained expiry request and complete the target
environment acceptance below. No production data loss was demonstrated by that
expiry result, and an idempotent retry remains a possible explanation.

## Release acceptance still requiring the target environments

Automated Obsidian filesystem seams and desktop WebKit are not native-device
acceptance. Verify actual Obsidian trash/create behavior and rename races on the
minimum supported host, installed iOS/Android behavior, hosted OAuth and push,
and paired D1/R2 restore into an independent Cloudflare account. Confirm hosted
log retention and private security-reporting settings. These checks remain
explicitly unverified; the local fixes do not imply they were performed.

Binary updates still require review. Concurrent frontmatter edits deliberately
favor preserved conflicts over automatic merging. Admission budgets are abuse
protection, not strict account-wide billing caps; see the
[API admission contract](worker-api.md#admission-before-database-work).
