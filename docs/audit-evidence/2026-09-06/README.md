# Audit evidence — 6 September 2026

Candidate: `12f01b7`, version `0.1.0`. [Full report](/Users/kaanbiryol/Documents/Projects/obsidian-crate/docs/pre-release-engineering-audit.md).

The reproduction sources are saved as `.txt` so they do not change the normal test suite, type checking or lint results. **They assert current defective behavior. A pass demonstrates a reproduced defect, not a fixed safety invariant.** Convert them into proper regression tests with reversed safety expectations when implementing fixes.

Production code, dependency versions, deployment state and Git history were left unchanged. Build outputs are ignored. Logs contain synthetic fixture content and test outputs, not a live user's vault. The full unit log includes the failing CSS expectations and is intentionally preserved.

## Verified outcomes

| Evidence | Outcome and scope |
|---|---|
| `worker-reproductions.ts.txt` / `crate-audit-repro-worker.log` | 9 tests. Real local D1/R2 with explicit fault injection. Four commit-cleanup paths, stale PWA form, duplicate create, repeated recurring completion, folder scope and delete/recreate ABA. Single-upload case also proves retry returns 200 while download remains 503. |
| `local-reproductions.ts.txt` / `crate-audit-repro-local.log` | 5 tests. Controlled vault write, actual shared reminder core, timezone metadata round-trip, DO class with paused push, and actual PWA hook with controlled responses. The DO/vault tests are not physical host/runtime interleaving certification. |
| `timezone-reproduction.mjs.txt` / `crate-audit-timezone.log` | Same serializer/parser bundled once and run in separate UTC/Berlin Node processes. Confirms a two-hour instant change. |
| `browser-reproductions.mjs.txt` / `crate-audit-browser-defects.log` | Built PWA and local preview server. Chromium confirms draft loss and another already-open tab retaining content after logout. WebKit times out during failed-save rollback; no equivalent WebKit conclusion. Preview authentication does not prove production revocation bypass. |
| `focus-adjusted.mjs.txt` / `crate-audit-focus-adjusted.log` | Diagnostic copy of baseline focus script with `tab=inbox`. Passes Chromium/WebKit. Baseline route starts on Today. |
| `ui-adjusted.mjs.txt` / `crate-audit-ui-adjusted.log` | Diagnostic copy increasing pull gesture from 85 to 200 pixels. Passes the damped threshold but fails the isolated layout expectation. This does not by itself prove a production layout bug. |
| `crate-audit-tests-node24.log` | Baseline unit suite: 978 passed, 3 failed; 171 files passed, 2 failed. |
| `crate-audit-worker-runtime.log` | Existing local Cloudflare integration suite: 13 passed in two files. |
| `crate-audit-build.log`, `crate-audit-final-*.log`, other check logs | Build, lint, type checks, deadcode, smoke, size, CSS and release-artifact results. |
| `crate-audit-dependencies.json`, `crate-audit-production-dependencies.json` | Full npm audit: two high and one moderate transitive development package findings; production-only audit: zero. These are registry advisory results, not reachability/exploit proofs. |
| `crate-audit-secret-scan.json` | Custom pattern scan of locally reachable history: 438 commits / 4,932 text blobs / 42,981,131 bytes. No matches for selected patterns or sensitive filenames. Not an exhaustive/vendor/entropy scan. |

## Re-run the focused reproductions

Use a disposable checkout of the audited commit with dependencies installed and a supported Node version. The original run used Node 24.19.0. Run from the repository root:

```sh
cp docs/audit-evidence/2026-09-06/worker-reproductions.ts.txt src/cloudflare/worker/pre-release-audit.integration.ts
npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/pre-release-audit.integration.ts
rm src/cloudflare/worker/pre-release-audit.integration.ts

cp docs/audit-evidence/2026-09-06/local-reproductions.ts.txt src/pre-release-audit.test.ts
npx vitest run src/pre-release-audit.test.ts
rm src/pre-release-audit.test.ts

cp docs/audit-evidence/2026-09-06/timezone-reproduction.mjs.txt scripts/.pre-release-timezone.mjs
node scripts/.pre-release-timezone.mjs
rm scripts/.pre-release-timezone.mjs
```

For browser reproductions, copy the corresponding `.mjs.txt` to `scripts/.pre-release-browser.mjs`, `scripts/.pre-release-focus.mjs` or `scripts/.pre-release-ui.mjs`, run it with Node, and remove that temporary file. Playwright Chromium and WebKit binaries must be installed. These scripts start an ephemeral local HTTP preview and close it; they do not contact or mutate a live Crate account.

The initial unsupported-Node-23 aggregate check is not used as the supported-runtime release result. The production build and unit failures were verified with Node 24, and final lint/type checks/deadcode were repeated after temporary tests were moved out of source. No clean-install or cross-Node reproducibility claim is made.
