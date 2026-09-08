# Pre-release audit remediation

Original candidate: `4b6c2911c62df31c08e656b44af76547b990e7be`. The original assessment and reproduction evidence are preserved alongside this checklist. Each independently reviewable fix receives its own commit. A second audit and final release-readiness assessment follow implementation and the complete release gate.

The [September 6 remediation record](audit-remediation-2026-09-06.md) is retained as historical evidence; its finding numbers belong to the earlier audit.

## Findings

| ID | Required outcome | Status / verification |
| --- | --- | --- |
| F01 | Preserve pending PWA work through involuntary authentication changes; isolate renewed scopes | Fixed: scoped review/export/recovery with exact replay and explicit logout privacy; 204 PWA tests and Chromium/WebKit failure/renewal/isolation regressions pass |
| F02 | Conserve current Markdown during stale/ambiguous reminder reordering | Fixed: mutation-time ownership/conservation checks; 9 plugin integration regressions and 5 Worker reorder checks pass |
| F03 | Reject incomplete local scans and revalidate absence before remote deletion | Fixed: full/force/cursor-fallback failures stop safely; automatic delete send paths recheck local state; 19 new regressions, targeted lint and typecheck pass |
| F04 | Invalidate all checkpoint generations and isolate deployment authority during reconfiguration | Fixed: stop and await old work, verify recovery copies, invalidate main/tmp, bind checkpoints to server authority, preserve same-server renewal baseline; 12 new regressions and all 377 sync tests pass; [recovery policy](sync-checkpoint-recovery.md) |
| F05 | Preserve stable reminder identity during project moves | Fixed: serialized scans verify current Markdown ownership, transfer vacated identities atomically in the index and defer ambiguous repair during incomplete sync; target/owner races and both move orders covered; 92 focused tests, lint and typecheck pass |
| F06 | Decode persisted dates deterministically across time and timezone changes | Fixed: durable decoding accepts explicit schedules, device-side adoption canonicalizes drafts once, recurrence metadata must match the readable rule, timed date keys use UTC; 41 focused tests and 3 new real Worker cache/mutation/projection regressions pass across clocks/timezones; parser cache v5 |
| F07 | Respect fenced Markdown and preserve task structure when adopting/reordering | Fixed: shared context guards preserve Markdown; additive schema4 tracks authoritative parser verification and resumes bounded R2 migration; old queued/installed alarms cannot deliver until verified, ghosts cancel and genuine first-observation times survive. 37 context tests plus final26 real Worker,24 unit and21 recovery tests pass, including combined coordinator query budget; lint and both typechecks pass |
| F08 | Enforce a representable hierarchical remote namespace transactionally | Fixed: indexed D1 publication guards and actionable namespace conflicts; 23 new runtime regressions, 71 focused unit and 34 runtime tests pass |
| F09 | Confirm and repair server push registration before displaying enabled | Fixed: authenticated confirmation plus current permission/endpoint/keys required for On; bootstrap/resume/reconnect repair and logout fencing; stable recipient IDs; Chromium/WebKit failure/race checks, 222 unit and 16 real Worker tests pass (provider delivery mocked) |
| F10 | Persist and visibly report incomplete reminder snapshots | Fixed: structured source notices survive acknowledgements, 304 and offline caches; legacy snapshots without issue metadata force fresh200; incomplete empty states stay truthful; 213 PWA/37 Worker tests and Chromium/WebKit native-cache/legacy-ETag preservation checks pass |
| F11 | Provide real content verification for unchanged filesystem fingerprints | Fixed: full reconciliation hashes bytes, periodic/incremental checks rotate within file/byte budgets, detected edits survive restart, and a safe immediate verification command is available; 384 sync tests plus final 8 verification regressions pass, including 10,000 files and the real incremental handoff; [policy](content-verification.md) |
| F12 | Preserve omitted description fields in partial updates | Fixed: only explicitly supplied description fields enter partial patches; six single-field changes including project moves preserve descriptions, explicit clears still work; 43 focused tests and 8 real Worker regressions pass |
| F13 | Converge confirmed reminder state across visible tabs | Pending |
| F14 | Refresh time-dependent views at clock/day/timezone boundaries | Pending |
| F15 | Persist deletion identity and revision correlation at commit time | Fixed: transactional deletion receipts preserve original request/actor, consumed/tombstone revisions and sequence through retries; additive schema 2→3 migration and 30-day audit retention; 60 unit, 51 Worker/D1/R2 and 17 recovery tests pass |
| F16 | Isolate malformed reminder projection from generic file publication | Fixed: atomic parse quarantine preserves opaque bytes and prior verified state; repair resumes projection; 16 new runtime regressions and focused checks pass |

## Additional audit concerns

| ID | Concern | Status / verification |
| --- | --- | --- |
| S01 | Recover interrupted plugin two-file reminder moves | Pending |
| S02 | Fence concurrent deployment publication and prevent downgrade races | Fixed: D1 ownership serializes current update/reset/delete clients, rechecks live identity/artifacts, and holds uncertain outcomes for exact-owner recovery; initial creation relies on provider7502 uniqueness with no unknown-outcome adoption; 89 unit/13 real-D1 interleavings/20 Python tests pass; old clients/direct admin must be quiescent during rollout |
| S03 | Define safe cache migration, blocked/failed upgrade and damaged snapshot recovery | Pending |
| S04 | Quarantine/export damaged outbox entries without discarding healthy pending work | Pending |
| S05 | Distinguish periodic connectivity failures from last successful sync | Fixed: failed checks show actionable errors without changing the last successful sync; recovery clears only its own error, failed syncs retain backoff, timer checks do not overlap and destruction fences late state; 19 focused tests, lint and typecheck pass |
| S06 | Record periodic sync results and provide safe diagnostic support | Fixed: queue/periodic results share persisted activity recording; bounded request/operation/session correlation survives settings reload; reviewable export whitelists counts/timestamps/IDs and excludes paths/content/credentials/raw errors; 409 sync/settings tests, lint and typecheck pass; [support guide](sync-diagnostics.md) |
| S07 | Define safe receipt/occurrence retention, retry horizons and compatibility | Pending |
| S08 | Make sync status keyboard accessible and clarify recurring completion undo | Keyboard portion fixed: focusable named button, Enter/Space, visible focus and listener cleanup; actual Chromium/WebKit component checks, lint and typecheck pass. Recurring undo remains pending |
| S09 | Align security/release checks and improve contributor/dependency maintenance setup | Pending |
| S10 | Document and verify protocol/schema/cache upgrade and rollback policy | Pending |
| S11 | Exercise larger sync workloads, interrupted multi-client histories and storage boundaries | Pending |
| S12 | Record exact-artifact hosted, physical-device, minimum-Obsidian and restore acceptance | Not yet verified; availability of required environments must be established |

## Completion requirements

- Every fix is independently committed with an appropriate regression/check.
- The complete release gate, visual suite, advisory and secret scans pass on the final candidate.
- A fresh independent audit examines the repaired system and its interactions; any new findings receive separate fixes and commits.
- Final readiness distinguishes verified behavior, remaining defects and unavailable hosted/physical acceptance evidence. Passing local tests alone does not establish public-release readiness.
