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
| F05 | Preserve stable reminder identity during project moves | Pending |
| F06 | Decode persisted dates deterministically across time and timezone changes | Pending |
| F07 | Respect fenced Markdown and preserve task structure when adopting/reordering | Pending |
| F08 | Enforce a representable hierarchical remote namespace transactionally | Fixed: indexed D1 publication guards and actionable namespace conflicts; 23 new runtime regressions, 71 focused unit and 34 runtime tests pass |
| F09 | Confirm and repair server push registration before displaying enabled | Pending |
| F10 | Persist and visibly report incomplete reminder snapshots | Pending |
| F11 | Provide real content verification for unchanged filesystem fingerprints | Pending |
| F12 | Preserve omitted description fields in partial updates | Pending |
| F13 | Converge confirmed reminder state across visible tabs | Pending |
| F14 | Refresh time-dependent views at clock/day/timezone boundaries | Pending |
| F15 | Persist deletion identity and revision correlation at commit time | Fixed: transactional deletion receipts preserve original request/actor, consumed/tombstone revisions and sequence through retries; additive schema 2→3 migration and 30-day audit retention; 60 unit, 51 Worker/D1/R2 and 17 recovery tests pass |
| F16 | Isolate malformed reminder projection from generic file publication | Fixed: atomic parse quarantine preserves opaque bytes and prior verified state; repair resumes projection; 16 new runtime regressions and focused checks pass |

## Additional audit concerns

| ID | Concern | Status / verification |
| --- | --- | --- |
| S01 | Recover interrupted plugin two-file reminder moves | Pending |
| S02 | Fence concurrent deployment publication and prevent downgrade races | Pending |
| S03 | Define safe cache migration, blocked/failed upgrade and damaged snapshot recovery | Pending |
| S04 | Quarantine/export damaged outbox entries without discarding healthy pending work | Pending |
| S05 | Distinguish periodic connectivity failures from last successful sync | Pending |
| S06 | Record periodic sync results and provide safe diagnostic support | Pending |
| S07 | Define safe receipt/occurrence retention, retry horizons and compatibility | Pending |
| S08 | Make sync status keyboard accessible and clarify recurring completion undo | Pending |
| S09 | Align security/release checks and improve contributor/dependency maintenance setup | Pending |
| S10 | Document and verify protocol/schema/cache upgrade and rollback policy | Pending |
| S11 | Exercise larger sync workloads, interrupted multi-client histories and storage boundaries | Pending |
| S12 | Record exact-artifact hosted, physical-device, minimum-Obsidian and restore acceptance | Not yet verified; availability of required environments must be established |

## Completion requirements

- Every fix is independently committed with an appropriate regression/check.
- The complete release gate, visual suite, advisory and secret scans pass on the final candidate.
- A fresh independent audit examines the repaired system and its interactions; any new findings receive separate fixes and commits.
- Final readiness distinguishes verified behavior, remaining defects and unavailable hosted/physical acceptance evidence. Passing local tests alone does not establish public-release readiness.
