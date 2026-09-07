# Evidence for the 2a564af re-audit

All checks were run locally on 2026-09-06 with Node 24.19.0. Production source was unchanged. The original modified website files were preserved.

| File | Meaning |
|---|---|
| `release-check.log` | `npm run release:check`, exit 0; 999 unit, 51 Worker integration, 17 recovery tests and browser/build gates |
| `visual.log` | `npm run test:visual`, 48 passed |
| `visual-types.log` | `npm run typecheck:visual`, exit 0 |
| `npm-audit.json` | Fresh npm audit, zero reported vulnerabilities |
| `secret-scan.txt` | Captured summary of the successful history/worktree Gitleaks run |
| `checkpoint-reproduction.log` | A01: expected dirty local file, observed empty changes/false detection |
| `notification-reproductions.log` | A02 and A03: expected preserved schedules, observed cancellations |
| `enrollment-reproduction.log` | A04: zero token exchanges and signed-out recovery text in Chromium/WebKit |

Probe sources are saved with `.txt` suffixes to keep intentionally failing audit probes outside the regular test/lint/dead-code project. The tests use real application logic; vault operations are mocked in the checkpoint test, Cloudflare local D1/R2 are used for notification tests, and the production PWA bundle runs against the preview server with an expired seeded credential for enrollment.

To reproduce against the audited commit, copy each source to its original location, run its command, then remove that temporary copy:

| Saved source | Original location | Command |
|---|---|---|
| `checkpoint-reproduction.test.ts.txt` | `src/sync/reaudit-checkpoint.test.ts` | `npx vitest run src/sync/reaudit-checkpoint.test.ts` |
| `notification-reproductions.integration.ts.txt` | `src/cloudflare/worker/reaudit-boundaries.integration.ts` | `npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/reaudit-boundaries.integration.ts` |
| `enrollment-reproduction.mjs.txt` | `scripts/reaudit-enrollment.mjs` | `node scripts/reaudit-enrollment.mjs` |

The notification runtime requires the generated Worker from `npm run build:worker`; the enrollment script builds the PWA/Worker itself. Dependencies and Playwright Chromium/WebKit must already be installed. These are expected-failure regression specifications for `2a564af`, not passing additions to its baseline gate.
