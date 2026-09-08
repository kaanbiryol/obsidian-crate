# Final candidate acceptance evidence

Candidate: **bb14136984e72dcd01888a5154dc55bc675fe85c**, Crate **0.1.0**, September 8, 2026. The later report commit contains documentation/evidence only. See the [final 17-section assessment](../../../pre-release-readiness-bb14136.md) and [machine-readable identity](candidate.json).

## Verified checks

- Full `npm run release:check`: exit 0 on Node 24.0.0. [Complete output](release-check.log) includes zero known dependency vulnerabilities; pinned Gitleaks 8.30.1 history/source scan (500 commits, no leaks); lint; both source typechecks; dead code; notices; 22 recovery tests; 1,562 unit tests in 215 files; 225 real local Worker/D1/R2 tests in 32 files; production preview/build; CSS; budgets; artifact verification; and all 19 Chromium/WebKit browser acceptance scripts.
- Visual TypeScript check: exit 0. [48 visual cases passed](visual.log).
- Clean Git archive of the candidate, fresh `npm ci` for **each** Node 20.19.0, 22.12.0 and 24.0.0; production build, size and artifact checks pass on each. All five artifact hashes/byte counts match across runtimes and the tested workspace. [Build matrix](reproducibility.json), [Node 20 log](build-node-20.19.0.log), [Node 22 log](build-node-22.12.0.log), [Node 24 log](build-node-24.0.0.log). Full test execution on all three versions/hosted Actions is not claimed.
- No release binary, generated application bundle or dependency directory is committed here. Logs and the screenshot are audit evidence.

The [ordered commit record](commits.txt) covers both remediation rounds. A [final history/current-source secret scan](evidence-secrets.log) also passed after the report and evidence were added.

## Release asset SHA-256

| File | SHA-256 |
| --- | --- |
| `main.js` | `061f2be0d7e19a66defdd69b7899a1454c9f6fea733bafb10c8e964327213750` |
| `styles.css` | `4cfe6f2949d4d3be2c0e0f08242f6f80202ee961edb4c37b0b81794669379a76` |
| `manifest.json` | `e7fff40af51d7388907e6ed6a2e60e7b472fd08eed026ef8658628c541d5003a` |
| Embedded Worker | `e3e6b4a035ce3e0bc012ca0440dd659c0b93ee85941369df985fe23dedef9798` |
| PWA build payload | `76a367fdc1d443f4c698a67decc284ab3509facec51a5504f71e7c05848e893c` |

The three plugin assets installed in the isolated Obsidian vault were byte-for-byte compared with this candidate. The Worker/PWA hashes identify generated build payloads, not a deployed server.

## Actual Obsidian evidence

A separate Obsidian **1.13.7** process used a disposable profile/vault containing only synthetic notes. Crate had no server configured and automatic sync was disabled. The user's existing Obsidian instance and vault were not used.

- [Before R06](obsidian-reload-before.json): repeated reload accumulated reminder leaves. [After R06](obsidian-reload-after.json): five reloads and three concurrent opens preserve the same single loaded pane, ten commands and reminder state, with no observed page errors. The final bundled artifact hash is included.
- [Final editor result](obsidian-editor.json): visible editor create, Enter-key edit, save, checkbox completion and exact record persistence after reload. [Screenshot](obsidian-editor.png) shows the completed fixture in the actual host; it is not a UI mockup.
- [Earlier repository smoke](obsidian-repository-earlier-candidate.json): real Vault/repository project movement, linked title/description preservation, finite recurring advancement, reopen/recomplete, single identity and reload persistence. This ran on `4da853e`; its original artifact hash is retained. R06 subsequently changed only pane lifecycle. Do not relabel those earlier repository checks as having been rerun against `bb14136`.
- [41 focused R06 tests](r06-regressions.log), [typecheck](r06-typecheck.log), [lint](r06-lint.log).

One exploratory editor assertion used the external reminder's `title` field instead of the internal index's `content` field. That harness assertion was corrected and the UI/persistence checks completed. The separate pane failure was a confirmed production defect, fixed and retested as R06.

## Repository policy snapshot

Read-only `gh api` calls captured [repository settings](github-repository.json), [private reporting](github-private-reporting.json), [master branch status](github-master-branch.json) and [branch rules](github-master-rules.json). The repository is public, private reporting is enabled, `master` is unprotected, and secret-scanning/push-protection/Dependabot security updates are disabled. Source-level weekly Dependabot proposals and security workflows are present. No policy setting was changed.

## Acceptance still required

The declared minimum Obsidian 1.13.0, physical iOS/Android, installed provider push, unrelated-account OAuth, hosted update/interruption, independent-account D1/R2 restore, hosted capacity, hosted CI/community scanner and exact draft release remain unverified. The available release lookup did not provide an Obsidian 1.13.0 test binary; this does not justify changing the declared minimum without evidence.

Use the [release checklist](../../../release-checklist.md) for those checks. Local workerd is a real runtime with local D1/R2 bindings; the sync capacity filesystem seam is simulated. Browser push provider acceptance is mocked. Browser timing results describe this machine, not physical-device or billed Cloudflare performance.

Paths to the home directory, workspace and disposable profiles are redacted in copied text. Synthetic reminder content/IDs are retained so conservation and identity checks remain reviewable.
