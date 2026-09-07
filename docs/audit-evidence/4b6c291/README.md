# Pre-release audit evidence

Candidate: `4b6c2911c62df31c08e656b44af76547b990e7be`, version `0.1.0`. Collected September 8, 2026, using Node 24.19.0 on macOS. The complete assessment is in [docs/pre-release-engineering-audit-4b6c291.md](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/pre-release-engineering-audit-4b6c291.md).

These are preserved observations of the audited candidate. The new reproductions **assert the faulty behavior**: a passing reproduction confirms a bug, not that the implementation is correct. Convert these assertions into preservation/convergence regressions when implementing fixes.

Only the report and this evidence directory were added to the repository. Temporary runnable tests were removed after execution. Production source, configuration, dependency lockfile, and Git history were unchanged. No live deployment or personal vault was used. Authentication values in the reproduction sources are local test fixtures.

## Baseline verification

| Evidence | Command and result |
| --- | --- |
| [docs/audit-evidence/4b6c291/install.log](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/install.log) | `npm ci`: succeeded under the supported Node version; no dependency advisories reported |
| [docs/audit-evidence/4b6c291/release-check.log](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/release-check.log) | `npm run release:check`: exit 0; lint, typechecks, dead-code/notices checks, 17 recovery tests, 1,299 unit tests across 196 files, 98 Worker-runtime tests across 16 files, preview/build/budget/artifact checks, Chromium and WebKit browser suites |
| [docs/audit-evidence/4b6c291/visual-check.log](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/visual-check.log) | `npm run typecheck:visual && npm run test:visual -- --workers=2`: exit 0; 48 visual tests passed |
| [docs/audit-evidence/4b6c291/dependency-audit.json](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/dependency-audit.json) | `npm audit --json`: zero reported advisories in every severity category; preserved metadata summary |
| [docs/audit-evidence/4b6c291/secret-scan.log](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/secret-scan.log) | `npm run security:secrets`: Gitleaks 8.30.1 scanned 456 commits and current source; no leaks reported |

To repeat the baseline, use a Node version supported by `package.json`, install the locked dependencies and the required Playwright browsers, then run the commands above from the repository root. This machine's default Node 23 is outside the declared range; the audit used `/Users/kaanbiryol/.local/share/mise/installs/node/24.19.0/bin/node`.

Baseline browser benchmarks are local, unthrottled preview measurements. The logs preserve the raw timing, payload and bundle-size results. They do not establish hosted performance or physical-device behavior.

## Reproduction inventory

The following 16 tests ran against production modules. Sources are stored with a `.txt` suffix so they do not join normal test, lint, typecheck or build discovery.

| Finding | Preserved source | Log | Tests and boundary exercised |
| --- | --- | --- | --- |
| F03, F04, F11 | [docs/audit-evidence/4b6c291/sync-reproductions.test.ts.txt](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/sync-reproductions.test.ts.txt) | [docs/audit-evidence/4b6c291/sync-reproductions.log](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/sync-reproductions.log) | 4: failed list/stat → actual planner/classifier/diff processor → delete API spy; unchanged metadata hides bytes; reset helper → checkpoint recovery |
| F02, F06, F07, F12 | [docs/audit-evidence/4b6c291/reminder-core-reproductions.test.ts.txt](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/reminder-core-reproductions.test.ts.txt) | [docs/audit-evidence/4b6c291/reminder-core-reproductions.log](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/reminder-core-reproductions.log) | 4: actual shared parser, normalization and Markdown mutation helpers |
| F05 | [docs/audit-evidence/4b6c291/reminder-move-reproduction.test.ts.txt](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/reminder-move-reproduction.test.ts.txt) | [docs/audit-evidence/4b6c291/reminder-move-reproduction.log](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/reminder-move-reproduction.log) | 1: actual writer, index and scanner; ordinary project move changes ID |
| F02 | [docs/audit-evidence/4b6c291/reminder-reorder-reproduction.test.ts.txt](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/reminder-reorder-reproduction.test.ts.txt) | [docs/audit-evidence/4b6c291/reminder-reorder-reproduction.log](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/reminder-reorder-reproduction.log) | 1: actual repository, writer and index with a copy/paste between indexing and reorder |
| F08 | [docs/audit-evidence/4b6c291/namespace-reproductions.integration.ts.txt](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/namespace-reproductions.integration.ts.txt) | [docs/audit-evidence/4b6c291/namespace-reproductions.log](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/namespace-reproductions.log) | 3: real Worker/D1/R2 ancestor-first, descendant-first and concurrent path publication |
| F06 | [docs/audit-evidence/4b6c291/reminder-relative-runtime.integration.ts.txt](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/reminder-relative-runtime.integration.ts.txt) | [docs/audit-evidence/4b6c291/reminder-relative-runtime.log](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/reminder-relative-runtime.log) | 2: real Worker/D1/R2 cached list versus update after midnight; delayed projection due-key mismatch |
| F16 | [docs/audit-evidence/4b6c291/reminder-malformed-runtime.integration.ts.txt](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/reminder-malformed-runtime.integration.ts.txt) | [docs/audit-evidence/4b6c291/reminder-malformed-runtime.log](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/reminder-malformed-runtime.log) | 1: real Worker/D1/R2 generic upload blocked by invalid reminder metadata, outside the reminders folder and with no push policy |

The plugin tests use an in-memory Obsidian adapter; they do not run the Obsidian desktop/mobile host. The Worker integration tests use local workerd, D1 and R2. F03 spies on remote deletion instead of sending it to a hosted server. F04 directly proves stale checkpoint recovery; its complete server-switch consequence was traced through configuration and reconciliation callers, not reproduced against a live deployment. F15 is an implementation/diagnostic-schema finding supported by source inspection, without a new runtime reproduction.

## Re-running the unit reproductions

In an isolated checkout of the candidate, copy each source to the following temporary location. The relative imports depend on these directories.

| Preserved source basename | Temporary runnable path |
| --- | --- |
| `sync-reproductions.test.ts.txt` | `src/sync/audit-release-4b6c291.test.ts` |
| `reminder-core-reproductions.test.ts.txt` | `src/reminders/core/audit-pre-release.test.ts` |
| `reminder-move-reproduction.test.ts.txt` | `src/reminders/core/audit-move.test.ts` |
| `reminder-reorder-reproduction.test.ts.txt` | `src/reminders/core/audit-reorder-caller.test.ts` |

Run only the copied tests:

```sh
npx vitest run \
  src/sync/audit-release-4b6c291.test.ts \
  src/reminders/core/audit-pre-release.test.ts \
  src/reminders/core/audit-move.test.ts \
  src/reminders/core/audit-reorder-caller.test.ts \
  --reporter=verbose
```

Expected result on the audited candidate: 10 passing assertions of faulty behavior. The list/stat error messages in the sync log are the injected failures, not unexpected test infrastructure errors.

## Re-running the Worker reproductions

Copy the three integration sources into `src/cloudflare/worker/` with these names:

| Preserved source basename | Temporary runnable basename |
| --- | --- |
| `namespace-reproductions.integration.ts.txt` | `audit-namespace.integration.ts` |
| `reminder-relative-runtime.integration.ts.txt` | `audit-relative-date.integration.ts` |
| `reminder-malformed-runtime.integration.ts.txt` | `audit-malformed-description.integration.ts` |

Then run:

```sh
npm run build:worker
npx vitest run --config vitest.cloudflare.config.ts \
  src/cloudflare/worker/audit-namespace.integration.ts \
  src/cloudflare/worker/audit-relative-date.integration.ts \
  src/cloudflare/worker/audit-malformed-description.integration.ts \
  --reporter=verbose
```

Expected result on the audited candidate: six passing assertions of faulty behavior. Remove only the temporary tests you copied when finished.

## PWA browser reproductions

Source: [docs/audit-evidence/4b6c291/pwa-reproductions.mjs.txt](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/pwa-reproductions.mjs.txt). Output: [docs/audit-evidence/4b6c291/pwa-reproductions.log](/Users/kaanbiryol/.codex/worktrees/bdfe/obsidian-crate/docs/audit-evidence/4b6c291/pwa-reproductions.log).

Five scenarios ran in each of Chromium and WebKit:

1. F01: a saved command becomes uncertain after a pre-commit 503; a subsequent 401 removes the command and authentication token.
2. F13: two visible tabs share an optimistic command; only the lock winner adopts the acknowledged result, exposing stale base data in the other tab.
3. F10: a successful list response contains source issues and omits reminders; the visible UI presents a healthy empty inbox without the issues.
4. F09: browser subscription creation succeeds and server attachment fails; a simulated pageshow/resume refresh displays On and hides the Enable action.
5. F14: advancing across midnight leaves the Today list stale; Chromium additionally verifies a subsequent 304 response does not repair it.

These use the actual built PWA, browser localStorage/IndexedDB/Web Locks and the repository preview server, with injected API responses. Service workers are blocked in these targeted reproductions. The PushManager is mocked, so this proves registration-state handling rather than physical push delivery. Separate baseline release checks exercise real browser service-worker installation and updates. WebKit's midnight reproduction does not claim the additional Chromium 304 step.

Copy the source to a temporary `.mjs` file. Its first three imports contain the original checkout's absolute path; update those prefixes if using a different checkout. Run the file with supported Node and installed Chromium/WebKit binaries from the repository root:

```sh
node /absolute/path/to/audit-pwa-reproductions.mjs
```

## Scope limits

No live Cloudflare OAuth/provisioning, physical Obsidian iOS/Android acceptance, real push-provider delivery, exact public-release asset installation, or independent-account hosted restore was performed. Static caller tracing is labeled separately from direct reproduction in the report. Local tests support the stated boundaries, not universal correctness under every interleaving.
