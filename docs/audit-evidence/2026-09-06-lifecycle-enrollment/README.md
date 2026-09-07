# Enrollment and plugin lifecycle remediation evidence

Date: 2026-09-06. Final candidate: `67cd40c1fdb6985bfccbf17e6babb8e8aa33c145`; version 0.1.0, protocol 5, schema 2.

[Final 17-section audit](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/pre-release-engineering-reaudit-67cd40c.md).

## Changes and candidate boundaries

- `0d9d958`: atomic enrollment exchange, startup/scan cancellation, obsolete consume helper removal and regression coverage.
- `67cd40c`: successful folder replacement registers reminder UI when it overtakes initial startup; the overlap test verifies exactly one view and command registration.
- `site/index.html` and `site/assets/site.css` remain unrelated working-tree changes. Historical audit documents are preserved. No generated release artifact, dependency directory, website edit or audit archive was committed.
- Commits are local. Nothing was pushed, tagged, published or deployed. GitHub repository settings were read without mutation.

## Final verification

| Evidence | Command/result | Scope |
|---|---|---|
| [final-release.log](final-release.log) | `npm run release:check`, exit 0 | Exact final source before its second commit; Node 24.0.0; 1,011 units, 73 Worker integrations, 17 recovery tests, lint/types/Knip/notices, browser/build/CSS/artifact/size gates |
| [visual.log](visual.log), [visual-types.log](visual-types.log) | `npm run test:visual`, `npm run typecheck:visual`, exit 0 | 48 visuals on first fix; final change only adds an existing idempotent registration call, shared visual rendering unchanged |
| [npm-audit.log](npm-audit.log) | `npm audit --json`, exit 0 | Zero reported vulnerabilities; lockfile unchanged |
| [final-secrets.log](final-secrets.log) | `npm run security:secrets`, exit 0 | Final committed history and working source |
| [clean-install.log](clean-install.log) | `npm ci`, exit 0 | Archived tracked source, locked dependencies on Node 24.0.0 |
| [final-release-matrix.json](final-release-matrix.json) | Three `npm run build` executions, exit 0 | Final committed source on exact Node 20.19.0, 22.12.0, 24.0.0; equal release hashes, also matching tested workspace |

The clean workspace was created from `git archive 0d9d958` and installed with `npm ci`; it passed a full release check on Node 24.0.0. After the additional two-file UI correction, it was refreshed with the complete final `git archive` using the same unchanged lockfile/dependencies, then rebuilt on all three exact Node versions. The final full release check ran in the main workspace. The other two versions were build checks, not full repeated suites or remote Actions results.

`clean-install.log` records npm allow-scripts warnings for native/build dependencies. The install and subsequent builds/tests succeeded; no dependency policy was changed.

## Release artifacts

| Artifact | SHA-256 |
|---|---|
| `dist/main.js` | `d350735c7cfebd7024b78486353825096fb8a2cad13090ea2eea2fced7a710d3` |
| `dist/styles.css` | `363fa581fbe07a14c2ae31bce715b1cc92551f1c6037f85989ab79428149692f` |
| `manifest.json` | `e7fff40af51d7388907e6ed6a2e60e7b472fd08eed026ef8658628c541d5003a` |

[Candidate metadata](candidate.json) also records Worker and lockfile hashes. `final-clean-build-*.log` contains individual build output. Use the final hashes, not `release-matrix.json`, which records the earlier `0d9d958` intermediate candidate.

## Failure evidence and regressions

- `folder-handoff-before.log`: expected failing probe on `0d9d958`; a superseding folder scan produced zero reminder view registrations. The expanded assertion is committed and passes in `final-release.log`.
- The earlier audit's failing enrollment and unload probes became real D1/deferred-lifecycle regressions in the first commit. `focused-unit.log` and `worker.log` record their initial passing runs.
- `release.log`, `clean-node-*.log`, `release-matrix.json`, `secrets.log` and `secrets-post-commit.log` record intermediate verification. They do not replace the final candidate evidence above.
- SQL failure injection occurs at all five boundaries around the four-statement replacement exchange. Tests verify rollback of the link/session/subscription, then successful retry; four concurrent attempts yield one session. Expired/missing links cannot revoke a prior session. Response loss after commit preserves single-use enrollment.
- Lifecycle regressions cover unload during settings/connection/reminder/sync awaits, stale-instance settings, repeated startup, superseded folder loading, layout-ready cancellation and normalization cancellation after reads/inside the atomic callback.

## Read-only hosted repository inspection

`github-repository.json` records public visibility and disabled secret scanning, push protection and Dependabot security updates. `github-master-rules.json` is empty; the branch endpoint also reported `protected: false`. `github-private-reporting.json` reports enabled. `github-releases.json` returned no releases. These establish G03's configuration gap, not an existing compromise.

## Remaining execution boundary

Independent-account OAuth/restore, minimum-version Obsidian, physical iOS/Android, installed push/update behavior, hosted load tests, remote Actions on these local commits and Obsidian community review were not completed here. The prior warm-list capacity measurements belong to `d66e0fa`; the unchanged list/cache code was reread, but these measurements were not repeated or relabeled as hosted/current-candidate performance.
