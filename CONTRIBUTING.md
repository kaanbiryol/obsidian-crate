# Contributing to Crate

Crate's Obsidian plugin, reminders PWA and Cloudflare backend share a sync and reminder contract. Start with [the architecture](docs/architecture.md), [protocol documentation](docs/protocol.md), and [testing guide](docs/testing.md). Report vulnerabilities through [the security policy](SECURITY.md), and use synthetic notes in public bug reports.

## Local setup

Use npm and a supported Node version (`^20.19.0 || ^22.12.0 || >=24.0.0`); `.nvmrc` records the release build version. Clone the full repository history so the release secret scan can examine all fetched refs. A shallow clone needs `git fetch --unshallow --tags` before the release gate.

```sh
npm ci
npx playwright install chromium webkit
npm run vault:setup
npm run dev
```

Open the ignored `test-vault/` in Obsidian and enable Crate under **Settings → Community plugins**. The watcher installs each successful development build there. Use a disposable vault and, only for hosted testing, a disposable Cloudflare account. Local unit, Worker-runtime and PWA preview tests require no Cloudflare credentials. See [deployment setup](docs/deployment.md) for explicit hosted enrollment.

## Where changes belong

| Area | Starting point |
| --- | --- |
| Plugin lifecycle, settings and commands | `src/plugin/`; `src/main.ts` stays a small entry shell |
| Sync planning, local checkpoints and transfers | `src/sync/` |
| Shared Markdown identity, mutation and recurrence rules | `src/reminders/core/`, `src/reminders/utils/` |
| Vault-backed reminder indexing and writing | `src/reminders/data/` |
| Browser session, cache, outbox and client UI | `src/pwa/` |
| Deployment authorization and provisioning | `src/cloudflare/` |
| Authenticated API, D1 publication, R2 and notifications | `src/cloudflare/worker/` |
| Wire formats and compatibility | `src/protocol/` |
| Paired backup and restore tools | `scripts/recovery/` |

Keep shared reminder rules in shared modules so plugin, PWA predictions and Worker mutations agree. A successful request must preserve byte, revision and operation-identity invariants under response loss and retries. File deletion requires verified absence; recovery must retain local-only intent. Use focused regression tests that reproduce the actual failure through the relevant boundary, including D1/R2 tests for publication guarantees.

## Checks and pull requests

Run focused tests while developing, then the release gate before requesting merge:

```sh
npm run release:check
```

The gate includes the npm advisory audit, pinned Gitleaks history/current-source scan, lint, both TypeScript targets, dead-code checks, license notices, Python recovery tests, unit and actual Worker-runtime tests, production artifacts, bundle budgets, and Chromium/WebKit PWA checks. The security checks require network access and fail on unavailable or incomplete results. The full release gate is supported on macOS/Linux x64/arm64; those are the platforms covered by the checksum-pinned scanner.

For shared UI changes also run `npm run typecheck:visual` and `npm run test:visual`. Review any intended screenshot changes; do not replace baselines just to make a failing comparison pass. Complete the relevant clean-vault smoke tests from the testing guide. Local tests do not substitute for the [exact-artifact public release checklist](docs/release-checklist.md).

Keep PRs focused, explain behavior and recovery implications, and state what was actually tested. Follow `AGENTS.md`: use lowercase Conventional Commits (`fix`, `feat`, `chore`, `refactor`, `perf`, `build`, or `ci`); use `ios`/`android` scopes only for platform-specific changes; omit coauthor trailers. Do not commit `node_modules/`, `.generated/`, `dist/`, vault settings or built release files.

## Dependencies and automation

Dependabot is configured to propose weekly npm and GitHub Actions updates. Development minor/patch changes may be grouped; runtime and major changes remain individually reviewable. This configuration creates no auto-merge rule. Its options follow [GitHub's Dependabot reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

Review upstream changes and newly introduced install scripts, licenses, bundle size and browser/mobile support. Keep `package-lock.json` with dependency changes, run `npm run notices:generate` when needed, and rerun the full gate. Security-sensitive dependencies such as parsing, cryptography, push and build tooling warrant their relevant regressions. Keep Actions pinned to full commit SHAs and review permission changes. Normalize squash commit messages to the repository's lowercase convention.

The advisory gate uses `npm audit --audit-level=low --include=dev`; [npm's documented threshold](https://docs.npmjs.com/cli/v11/commands/npm-audit/) makes known advisories fail the command. Do not bypass a failing audit with a threshold change or apply forced major upgrades without review. The release checklist separately requires maintainer-controlled GitHub settings, hosted acceptance and physical devices; adding local configuration does not prove those external checks passed.
