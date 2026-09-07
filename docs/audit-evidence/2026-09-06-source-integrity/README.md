# Evidence for remediation and audit of d66e0fa

Candidate: `d66e0fa2059b0b439f7455bb57fe47f1ba64575f`, 2026-09-06. Main test runtime: Node 24.19.0, local macOS; Cloudflare tests use local D1/R2 bindings. The `candidate.json` file records exact release and bundled artifact SHA-256 hashes.

The commit fixes A01–A05 from the previous `2a564af` report. Committed regressions are `src/sync/applied-content.test.ts`, `src/cloudflare/worker/reminder-source-integrity.integration.ts`, `src/cloudflare/worker/enrollment-recovery.integration.ts`, the PWA safety script, provisioning checks and paired-recovery assertions. Existing suites were updated for protocol 5, schema 2 and smaller mutation batches.

## Passing gates

- `reaudit-release-check.log`: post-commit `npm run release:check`, exit 0; 1,003 unit tests, 63 Worker integration tests, 17 recovery tests, both browser engines, lint/types/Knip/notices, artifacts/CSS/sizes.
- `clean-release-check-node-24.0.0.log`: the full release gate again in the clean checkout on the exact `.nvmrc` runtime, exit 0, with the same test counts and browser results.
- `release-check.log`: earlier full remediation gate, exit 0; before the extra old-schema rejection test and recovery row assertions were added.
- `schema-check.log`, `recovery-check.log`: focused validation of those final assertions, exit 0.
- `visual.log`, `visual-types.log`: 48 visual cases and visual TypeScript check, exit 0. Production UI bytes did not change after these checks.
- `npm-audit.json`: zero reported vulnerabilities.
- `reaudit-secrets.log`: pinned Gitleaks scan after the commit, 437 commits plus current source, exit 0. `secrets.log` is the earlier pre-commit scan of 436 commits plus pending fixes.
- `clean-install.log`: clean `npm ci` in an isolated archive of the committed candidate on Node 24.0.0. `clean-checkout-path.txt` records the temporary checkout.
- `clean-build-node-*.log`, `reproducible-builds.json`: exact Node 20.19.0, 22.12.0 and 24.0.0 build results and hashes. Builds reuse the clean locked dependency install; they do not represent three independent OS/CI runs.

All three exact release-matrix builds agree (`matchesReleaseMatrix: true`). The earlier Node 24.19.0 local `main.js` hash differs (`matchesCandidate: false` in that comparison). `compression-comparison.json` proves that only the gzip representation of the embedded Worker differs: its decompressed hash and all other plugin bytes are identical. `release-matrix-artifacts.json` records the canonical build hashes for physical/hosted testing. The initial comparison script stopped on this difference; subsequent builds and the byte comparison resolved it as a runtime compression difference, not a release-matrix mismatch.

Initial sandbox restrictions prevented local server listeners or the secret scanner download. Authorized escalated reruns completed successfully. These were environment failures, not release defects; no external deployment or actual vault content was used.

## Additional audit probes

- `lifecycle-probe.txt` is a copy of the candidate lifecycle test harness with `lifecycle-probe-addition.txt` appended. It was temporarily run as `src/plugin/audit-lifecycle.test.ts` with `npx vitest run src/plugin/audit-lifecycle.test.ts -t 'audit:'`. The safety assertion fails: startup initializes services after shutdown while settings load was pending. Output is in `lifecycle-probe.log` (exit 1). This controls the lifecycle interleaving; it is not an actual Obsidian UI reproduction.
- `capacity-and-enrollment-probe.txt` was temporarily copied to `src/cloudflare/worker/audit-candidate.integration.ts` and run using `npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/audit-candidate.integration.ts`. `capacity-and-enrollment.log` records the new enrollment failure: token deletion succeeded, session creation failed before commit, retry returned 401. Exit 1, with one failing safety assertion and two passing capacity cases.
- `capacity-1000.log` and `capacity-10000.log` rerun each warm-list case separately, exit 0. Each asserts the complete unique reminder count, no issues and conditional 304 behavior. Normal timing console output was suppressed by the local Worker runner.
- `capacity-measurement-probe.txt` changes only the final capacity log to an intentional `AUDIT_MEASUREMENT` error. `capacity-measurements.log` therefore exits 1 by design after all completeness/status checks, carrying timing samples in the diagnostic messages. Those two errors are **measurement transport, not discovered application failures**.
- `capacity-results.json` extracts those timing records. Five samples per fixture, one reminder per file, production parser-generated cache, local warm D1 list only. Authentication, R2, hosted CPU, network and browser rendering are excluded. Median 200/304 wall time: 15/3 ms at 1k, 123/18 ms at 10k. Response bytes: 286,930 / 2,878,930. Handler D1 query count: 3 for 200, 1 for 304.

Both temporary executable probe files were removed from `src/`. No production code was edited during the post-commit analysis. The report and this evidence remain local review artifacts; historical audit files and unrelated website changes were preserved.

Hosted independent-account OAuth/restore, exact minimum Obsidian, physical iOS/Android push/background/install and hosted capacity have not been run here. No passing claim is made for them.
