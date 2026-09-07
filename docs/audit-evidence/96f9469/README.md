# Re-audit evidence for 96f9469

Audited 6 September 2026 after committing `96f9469234481c8bc2798b393929f287b6b04cbc` (`fix: harden sync integrity and prerelease safety`). The committed source was unchanged throughout the repeat audit. Temporary reproduction files were removed after their sources were archived here as `.txt` files.

The full release check ran against the committed candidate **before** adding the temporary reproductions. The reproduction assertions intentionally demonstrate defects; passing these tests means the defect reproduced, not that the affected behavior is safe.

Environment: macOS 26.5.1, Apple silicon, Node 24.19.0, npm with the existing locked installation, Vitest 4.1.8, Playwright 1.58.2. Cloudflare integration checks used local workerd D1/R2. New alarm tests invoked the actual `ReminderAlarm` class with controlled storage and a mocked push sender; they did not test physical push delivery or the hosted alarm scheduler. The browser logout reproduction used the bundled PWA and preview server in Chromium and WebKit. Recovery reproductions used controlled HTTP/remote adapters and real local SQLite/archive code.

| Evidence | Result |
|---|---|
| `release.log` — `npm run release:check` | Passed: lint, both source type checks, dead code, notices, 5 recovery tests, 1,013 unit tests, 42 local Cloudflare runtime tests, preview, production build, CSS scope, size budgets, release validation, Chromium/WebKit browser checks. |
| `visual.log` — `npm run test:visual` | 48 passed without changing baselines. |
| `npm-audit.json` — `npm audit --json` | Zero reported vulnerabilities, including development dependencies. |
| `secrets.log` — `npm run security:secrets` | Gitleaks 8.30.1: 434 available commits and current source, no findings. |
| `client-repro.log` | 3 reproduced: local delete race, real API/logout composition, edited retry payload with an unchanged operation ID. |
| `worker-repro.log` | 6 reproduced: stale completion/title alarm, duplicate accepted schedule delivery, invisible exhausted delivery, legacy/expired recipient eligibility, changed-body receipt conflicts. |
| `logout-browser.log` | Both engines cleared the local session while sending zero `DELETE /auth/session` requests. |
| `recovery-repro.log` | 2 reproduced: HTTP 429 is not retried; a lost upload acknowledgement prevents resuming into the same restore target. |
| `final-static.log` | Lint and visual type checks after removing temporary source files. |
| `artifact-sha256.json` | SHA-256 of local plugin/Worker artifacts and manifest associated with the audit. Generated artifacts are not committed. |

`delete-repro.log` is the earlier isolated run of the delete reproduction, also included in the three-test client run. Do not add it to the test count. Eleven focused tests plus two browser runs substantiate eight findings. Preliminary fixture setup errors were corrected before the final runs captured here; they were not production failures. The first browser reproduction also attempted to inspect a toast after the authenticated shell unmounted. The final browser assertion observes actual server requests, and the unit reproduction independently checks the returned cleanup-failure result.

## Reproduce

Use an isolated checkout of the audited commit and Node 24.19.0. Install dependencies with `npm ci`; install Playwright Chromium/WebKit if needed. `source-map.json` maps each archived source to its original repository path. Copy only these files to those paths, then run:

```sh
npx vitest run src/pwa/audit-96f9469.test.ts src/sync/audit-96f9469.test.ts
npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/audit-96f9469.integration.ts src/cloudflare/worker/audit-security-96f9469.integration.ts
node scripts/audit-logout-96f9469.mjs
python3 scripts/recovery/audit_96f9469.py
```

The Python audit imports the committed recovery test fixture. Alarm tests manually fire due events to place them at the exact projection/outbox boundary; push calls are intercepted. No Cloudflare credentials, real vaults, remote deployments, or external messages are used. Remove the copied temporary files afterward. These small audit fixtures are not intended as permanent passing regression tests; fixes need assertions inverted to the desired invariant and appropriate additional cases.

The clean-install and cross-Node byte-reproducibility results recorded in the earlier remediation evidence predate this commit; they were not repeated in this re-audit. No hosted CI, independent-account OAuth/deployment, hosted restore, community-directory review, physical Obsidian, or installed mobile push test was performed.
