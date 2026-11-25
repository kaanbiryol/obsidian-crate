# Testing

Start with [Choosing tests](#choosing-tests) to pick the checks for a change. The suites, where they run in CI and the release gate follow; harnesses come after the manual checks, and notes for individual features start at [Feature-specific notes](#feature-specific-notes).

## Choosing tests

Match verification to the change. Scripts in `package.json` are the source of truth; each row lists the checks to run before review, beyond `npm run lint` and the relevant type-check.

| Changed area | Run |
| --- | --- |
| Any TypeScript module | `npx vitest run <file>` for the tests beside it, then `npm test` |
| `src/sync`, `src/encryption`, `src/protocol`, `src/reminders/core` | `npm run test:coverage` (coverage floors). Frozen-format and property tests run in the unit suite; see [Guardrail tests in AGENTS.md](../AGENTS.md#guardrail-tests) |
| Wire formats, release manifest, shortcut protocol, transfer limits | `node scripts/check-contract-docs.mjs --write`, then `npm run check:contracts` |
| Worker handlers, D1, R2 or Durable Objects (`src/cloudflare/worker/`) | `npm run typecheck:worker` and `npm run test:worker-runtime`; one file: `npx vitest run --config vitest.cloudflare.config.ts <file>` |
| Server-side behavior that needs a new server revision | `npm run check:server-revision`; see [server upgrades](server-upgrades.md) |
| `packages/server/` | `npm run typecheck:server`, `npm run test:local-server`, `npm run test:server-package`; `npm run test:docker` for the image |
| PWA (`src/pwa/`) | `npm run test:pwa-preview`, then the affected `node tests/browser/pwa/<name>-test.mjs` scripts or `npm run test:pwa-browser`. Service worker: `npm run typecheck:service-worker` |
| Reading | `npm run test:reading`, or `npm run test:reading-server` / `npm run test:reading-browser` |
| Shared UI, components or Sass (`src/ui/`, `*.scss`) | `npm run check:style-tokens`, `npm run check:css-scope`, `npm run size-check`, then `npm run test:visual` or `node scripts/visual-test-run.mjs <spec>`; see [UI styling](ui-styling.md#making-a-visual-change) |
| Reminder editor | `npm run test:editor-contract`; `npm run test:lexical` for rich-text work |
| Plugin activity, file history or dialogs | `npm run build`, then `npm run test:activity-browser`, `npm run test:file-history-browser` or `npm run test:plugin-dialogs` |
| Build, release or check scripts in `scripts/` | `npm run test:ci` |
| `scripts/recovery/` | `npm run test:recovery` |
| Dependencies | `npm run notices:generate`, `npm run deadcode`, `npm run security:check`, `npm run size-check` |
| Documentation only | Link and diff review; `npm run build:site:docs` builds the docs site and checks its links |
| A release | A successful **Release plugin** run for the exact commit, or `npm run release:check`; see [Release verification](#release-verification) |

`npm run check` covers everything except the browser suites. Changes that reach the Obsidian UI also need the [manual smoke test](#manual-obsidian-smoke-test).

## Suites and commands

[Framework and config](#framework-and-config) describes the unit, Worker runtime, local server and Docker suites in more detail.

| Suite | Command | Notes |
| --- | --- | --- |
| Unit tests | `npm test` | Vitest over `src/**/*.test.ts`. One file: `npx vitest run <file>`. |
| Unit coverage floors | `npm run test:coverage` | The unit suite with V8 coverage. Fails when `src/sync`, `src/encryption`, `src/protocol` or `src/reminders/core` drop under the floors in `vitest.config.ts`. `check:source` and CI run this instead of `npm test`. |
| Frozen formats | `npx vitest run src/**/*.fixtures.test.ts src/encryption/format-fixtures.test.ts` | Part of the unit suite. Decode append-only samples in `__fixtures__/` folders. Encrypted formats: `CRATE_WRITE_ENCRYPTION_FIXTURES=1` writes only missing entries. Others: `CRATE_WRITE_FIXTURES=<file name>` writes only that missing file (see `src/test/frozen-fixtures.ts`). |
| Old-client replay | `npm run test:worker-runtime` | `src/cloudflare/worker/old-client-replay.integration.ts` replays recorded protocol 1 client requests against local D1, R2 and Durable Objects. |
| Property tests | `npx vitest run src/**/*.property.test.ts` | Part of the unit suite. fast-check invariants for sync reconciliation, reminders and the PWA outbox. |
| Worker runtime | `npm run test:worker-runtime` | Builds both Workers, then runs the `*.integration.ts` suites against local D1, R2 and Durable Objects. They run the self-hosted Worker (`wrangler.jsonc`), the superset, except `cloudflare-bundle.integration.ts`, which runs the Cloudflare Worker the plugin deploys (`vitest.cloudflare-bundle.config.ts`, `wrangler.cloudflare.jsonc`) and checks that its server info, limits and routes are unchanged. Durable Objects run the built Worker, not the source, so both configs rebuild it first when it is missing, a development build, or older than a recorded input (`scripts/worker-test-setup.mjs`); running one file with `npx vitest` never tests stale code. |
| Local server | `npm run test:local-server` | Builds the Worker, then runs every `packages/server/test/*.test.mjs`. |
| Server package | `npm run test:server-package` | Packs the server and installs it through npx in an isolated cache. |
| Docker hosting | `npm run test:docker` | Needs a running Docker engine and Compose. |
| Tooling and release scripts | `npm run test:ci` | Node tests in `scripts/`, including the source-path guard and PWA browser shard coverage. The guard also fails when a `scripts/*.test.mjs` or `tests/**/*.test.mjs` file runs from no package script. |
| Server revision | `npm run test:server-revision` and `npm run check:server-revision` | The second checks the server revision and schema against the published release baseline; it needs Git history and `gh`, so it runs beside `check:source` in CI and `release:check` rather than inside it. |
| Recovery tooling | `npm run test:recovery` | Python `unittest`. |
| Contract docs | `npm run check:contracts` | Rejects stale values in `current-contract.md`; `node scripts/check-contract-docs.mjs --write` refreshes them. |
| Static checks | `npm run lint`, `typecheck`, `typecheck:worker`, `typecheck:service-worker`, `typecheck:server`, `typecheck:visual`, `deadcode`, `notices:check`, `check:style-tokens`, `check:css-scope` | Run each as `npm run <name>`. The type-checks keep incremental state in the ignored `.generated/tsc/`. |
| Source checks | `npm run check:source` | Builds the Worker, then runs lint, the plugin, Worker, service-worker and server type-checks, `deadcode`, `notices:check`, `check:contracts`, `check:style-tokens`, `test:ci`, `test:server-revision`, `test:recovery` and `test:coverage`. |
| Everything except browsers | `npm run check` | `check:source`, then `test:worker-runtime` and `test:local-server`. |
| PWA preview smoke test | `npm run test:pwa-preview` | Smoke test of the built PWA preview and its asset budgets. |
| PWA browser | `npm run test:pwa-browser` | Chromium and WebKit, registered in `scripts/browser-tests.mjs`. `-- --platform=linux --shard=1/4 --list` selects and lists a CI group. One script: `node tests/browser/pwa/<name>-test.mjs`. See [Browser tests](#browser-tests). |
| Reading | `npm run test:reading` | `test:reading-server` (extraction, server and shortcut contracts), then `test:reading-browser`. |
| Shared UI | `npm run test:visual` | Screenshot comparisons on the reviewed macOS baselines, then the editor contract. A subset: `node scripts/visual-test-run.mjs <spec>`. Local runs record no traces; add `--trace=on` when debugging a failure. |
| Editor contract | `npm run test:editor-contract` | Playwright editor contract, then the PWA editor contract script. Uses half the local cores (4 workers on CI); `--project=chromium-pwa` runs one of its four projects. |
| Plugin browser | `npm run test:activity-browser`, `npm run test:file-history-browser`, `npm run test:plugin-dialogs` | Run `npm run build` first. Each runs a registry group: `node scripts/browser-tests.mjs --group=<activity\|file-history\|plugin-dialogs>`; add `--list` to print its scripts. |
| Benchmarks | `npm run benchmark:reminders`, `npm run benchmark:sync`, `npm run benchmark:pwa` | See [reminder capacity measurements](sync-capacity.md#reminder-capacity-measurements) and [sync capacity](sync-capacity.md). |
| Focused bundles | `npm run test:page-titles`, `npm run test:lexical` | Editor work. Their pieces also run in the suites above; there is no dedicated CI job. |
| Release gate | `npm run release:check` | See [Release verification](#release-verification). |

## Where suites run

Pull requests and pushes to `master` and `release/**` run `lint.yml` ("Node.js build"), so each pull request commit is verified once. A branch without a pull request runs only through a manual dispatch. The **Release plugin** workflow runs the same reusable `verify.yml` for a release commit. New commits cancel obsolete branch runs. `npm run release:check` is the local alternative for the whole gate.

| `verify.yml` job | Runner | What it runs |
| --- | --- | --- |
| `checks` | Linux | `security:audit` and `security:secrets` (separate steps), the `check:source` commands (one step each), `check:server-revision`, `typecheck:visual`, `build:plugin`, `test:pwa-preview`, `check:css-scope`, `size-check`, `verify:release-artifacts`, then the release candidate record and asset staging. |
| `worker` | Linux, Playwright container | `test:worker-runtime`, `test:reading-server`, the `packages/server/test/*.test.mjs` tests (the `test:local-server` tests) and `test:server-package`. |
| `docker` | Linux AMD64 and ARM64 | `test:docker`. |
| `editor` (4 shards) | Linux, Playwright container | The editor contract Playwright shard on each; `test:activity-browser` on shard 1, `test:file-history-browser` on shard 2 and `test:plugin-dialogs` on shard 3. |
| `pwa` (4 shards) | Linux, Playwright container | `test:pwa-browser -- --platform=linux --shard=N/4`. Failed scripts retry once on CI and are logged as flaky. |
| `pwa-native` (3 shards) | macOS | `test:pwa-browser -- --platform=macos --shard=N/3`. Failed scripts retry once on CI and are logged as flaky. |
| `visual` | macOS | `scripts/reading-shortcut.test.mjs` (the native shortcut parser), then `scripts/visual-test-run.mjs`. |
| `reading` (2 groups) | Linux, Playwright container | `test:reading-browser:library` or `test:reading-browser:annotations`. |
| `reproducible` | Linux | Only when a release tag is supplied: a clean-install Worker and plugin build (`build:worker` and `build:plugin`, without the repeated type check) compared with the checked artifacts. |

CI runs each `check:source` command as a separate step so one failure does not hide the others. Linux browser jobs use a pinned Playwright image with preinstalled browsers and OS dependencies; update its version and digest alongside the Playwright lockfile version. The native PWA shards stay on macOS for native menus, font geometry and WebKit rendering/focus checks. The visual job keeps the reviewed macOS snapshot platform. These four macOS jobs stay under the hosted macOS concurrency limit, leaving a slot for overlapping runs. Automatic visual comparisons run here once; the separate visual workflow is for manual comparisons and baseline generation.

`release:check` covers the same suites except `test:docker` and the `reproducible` rebuild, which run only in CI. `test:ci` fails when a `release:check` command has no matching CI step; `scripts/release-verification.test.mjs` maps sharded commands and allowlists local-only steps, such as exporting `CRATE_WORKER_PREBUILT`. A release run that reuses a successful push build of the tag commit, or of its version-only parent, skips the test jobs; see [verification reuse](releases.md#prepare-a-draft-with-one-command).

Other workflows: `pages.yml` runs `check:docs`, the shortcut and site-deployment tests and the site build for documentation, site and shortcut changes; it deploys only for a published release or a manual run. `visual.yml` is manual, for baseline review and generation.

## Browser tests

To inspect or reproduce a PWA browser shard:

```bash
npm run test:pwa-browser -- --platform=linux --shard=1/4 --list
npm run test:pwa-browser -- --platform=linux --shard=1/4
npm run test:pwa-browser -- --platform=macos --shard=1/3
```

Omitting both `--platform` and `--shard` runs the complete browser suite. The Linux and native macOS groups cover every script exactly once; `test:ci` checks their combined coverage and balance. Groups are balanced by the measured script durations in `scripts/browser-durations.json`, which records the CI run they came from (`source`) and any local measurements (`additionalSources`); refresh it from CI logs whenever workloads change. The runner reports each script's duration and collects ordinary test failures so one run exposes all failures in that group. Each CI shard has its own checkout; do not run shards concurrently in the same working directory.

The runner builds the Worker/PWA once, then sets `CRATE_WORKER_PREBUILT=1` for its child scripts, which verify and reuse those fresh assets. Standalone scripts build by default; tests requesting explicit asset versions (including service-worker updates) always build those versions separately. Missing prebuilt assets fail the test. `npm run test:ci` checks shard coverage and balance, runner failure handling, and metadata-independent asset versions.

Reading checks use the same named groups locally and in CI: `test:reading-server`
covers extraction, server behavior, and shortcut contracts; `test:reading-browser`
covers the library, consent, optimistic changes, highlights, and shortcut browser
flows in two groups (`library` and `annotations`, one CI job each), one browser script at a time to avoid competing selection and focus tests.
Both groups require Chromium/WebKit and a built Worker. `test:reading` builds the
Worker and runs both groups.
File/vault history and plugin dialog browser checks also run in `release:check`.

Browser files follow one naming rule, which `test:ci` enforces: entrypoints end in `-test.mjs` and imported helper modules in `-checks.mjs`; shared fixtures live in `tests/browser/support/` (the PWA preview server and assets in `support/preview/`). Every entrypoint must be in the registry, a registry group, or a package script.

PWA asset hashing and raw server-input tracking exclude Finder/Explorer metadata (`.DS_Store`, AppleDouble `._*` files, `Thumbs.db`, and `desktop.ini`). Actual source files, including other dotfiles, still affect the version.

Touch-swipe tests park the desktop cursor outside the viewport before each gesture. This prevents WebKit's layout-driven mouse-hover events from interrupting the simulated finger. The drawer test deliberately starts with a stale hover position as regression coverage. Failures save touch/pointer events, drawer state and a screenshot to `.generated/browser-failures/`; CI uploads these as `pwa-failures-<shard>`.

## Release verification

Require the full release gate before publishing either deliverable. A successful
**Release plugin** run for the exact release commit satisfies the automated gate;
complete the applicable [device and hosted acceptance](#public-release-acceptance)
against its exact draft assets. Use focused checks during development rather than
repeating the full suite locally after successful CI. To reproduce the complete
gate locally:

```bash
npm run release:check
```

It first runs the npm advisory audit (including development dependencies, failing at low severity) and a checksum-pinned Gitleaks scan of complete fetched Git history and current source. Network failures and shallow clones fail this gate. It builds and checks the plugin, Worker and service-worker TypeScript targets, runs lint, dead-code analysis of both the full project and production dependency graph, the complete unit and Worker-runtime suites, the packed standalone server test, and the PWA preview smoke test. It then creates production plugin and Worker artifacts, enforces raw/gzip size budgets, validates manifest/version consistency and required Wrangler bindings, and checks for the OAuth deployment entry point. Chromium/WebKit tests cover PWA storage, recovery, authentication, updates, concurrency, clock boundaries and capacity. Capacity benchmarks remain in the gate.

`release:check` builds the Worker once, then exports `CRATE_WORKER_PREBUILT=1` so the nested `build:worker` calls (in `check:source`, the server revision, Worker runtime, local server, server package and Reading suites, and the browser runner) reuse that output. In that mode `scripts/build-worker.mjs` fails instead of reusing output that is missing, a development build, or older than any recorded Worker input in `.generated/cloudflare/server-inputs.json`. Do not export the variable in an interactive shell.

Asset limits are defined once in `scripts/bundle-budgets.mjs`; the artifact checks and PWA smoke test use the same byte limits. The individual size gates are also available as `npm run size-check:plugin` and `npm run size-check:worker`. A Cloudflare configuration change should additionally pass:

```bash
npx --yes wrangler@4.123.0 deploy --dry-run
```

[Preparing a plugin release](releases.md) covers signing and uploading the public shortcut, dispatching verification, reusing a push run or its version-only parent, the reproducible rebuild and attaching verified assets to the draft. Publish the draft only after completing the physical-device and hosted acceptance record below.

## Public-release acceptance

Keep candidate-specific acceptance records and artifact checksums outside version control. Complete the checks below before publishing.

Record the Obsidian version, operating-system version, and result for each device. Complete this matrix against the exact release assets before publishing:

- Run at least one pass on Obsidian 1.13.0, the version declared in `manifest.json`. If it is unavailable or any required flow fails, raise `minAppVersion` and the matching `versions.json` entry to the oldest version actually tested.
- Use a Cloudflare account that is not owned by or a member of the OAuth-client publisher. Confirm the verified publisher and exactly Workers Scripts Write, D1 Write, Workers R2 Storage Write, Memberships Read, and Account Analytics Read.
- Install `main.js`, `manifest.json`, and `styles.css` from the prepared release assets into a clean desktop vault. Complete OAuth, the first sync (which performs the initial import), restart, reconnect, and server update.
- On a physical iOS device, select **Connect with Cloudflare**, then **Open Cloudflare**. Complete authorization in the browser and confirm the callback reopens Obsidian (or **Open Obsidian** does). Join the existing server, then select **Crate: Sync now** in the command palette. Create, edit, rename, and delete Markdown and binary files; preserve a concurrent-edit conflict; background and resume Obsidian; then disable and re-enable Crate.
- Repeat the same Cloudflare sign-in and existing-server flow on a physical Android device.
- On both mobile platforms, create, edit, complete, reorder, and delete reminders. Install the reminders web app, enable push, receive both a test notification and a scheduled reminder, verify sign-out, and confirm a signed-out browser cannot use the previous session.
- On both mobile platforms, exercise the settings tab: sync controls and exclusions, reminder and notification options, web app **Open app**, Reading **Open web reading**, connected devices, Cloudflare usage and dashboard, and recovery dialogs. Check link and clipboard fallbacks from the same phone. If Reading is enabled, test its library and a new browser setup link. Record any settings that cannot be reached or changed.
- Confirm **Disconnect this device** removes only the local credential, while explicit Cloudflare resource deletion removes the remote copy as documented.

## Framework and config

- **Framework:** vitest
- **Config:** `vitest.config.ts`
- **Test pattern:** `src/**/*.test.ts` (co-located next to source)
- **Path aliases:** `@` and `src` -> `src/`, `obsidian` -> `src/test/mocks/obsidian.ts`

```bash
npm test                                  # run all tests
npm run test:worker-runtime               # run D1/R2/Durable Object tests in the Workers runtime
npx vitest run src/sync/planner/full.test.ts   # single test file
```

`vitest.cloudflare.config.ts` uses Cloudflare's Vitest plugin with `wrangler.jsonc`. The runtime suite applies the initial schema to an isolated D1 database and exercises real D1, R2, and Durable Object bindings locally.

`npm run test:local-server` exercises the standalone launcher through real HTTP
and persistent storage. It checks credentials, transaction rollback, file bytes,
upload receipt replay and an overdue Durable Object alarm across shutdown/restart,
plus exclusive directory ownership and schema rejection. It uses temporary data.
Remote setup tests run the real launcher and workerd with a fake `cloudflared`
executable; they cover saved launches, DNS failure recovery, tunnel shutdown,
credential permissions, and missing credentials. They create no public resources.
Quick Tunnel tests also cover hostname discovery, startup failure, timeout cleanup,
and rejection of downloads with an invalid checksum. `local-server-lifecycle.test.mjs`
injects cleanup failures, checks that later resources are still attempted, retains
the original startup error, and verifies HTTP draining before storage disposal.
`npm run test:server-package`
installs a packed artifact through npx in an isolated cache and exercises real
HTTP and storage across changing public URLs, using a fake connector.
Production launcher modules live in `packages/server/src/`. Their tests live in
`packages/server/test/`, which the packager does not ship; `npm run test:local-server`
runs every `*.test.mjs` there, so new files need no registration. Together with
`test:server-package` they cover both repository execution through the thin script
entry and the complete package copied into the installed `scripts/` directory.
Pairing tests cover expiry, concurrent redemption, and hash-only credential
storage. Readiness tests reject stale instance identities and retry DNS failures.
Backup tests restore R2 data, device credentials, and a real scheduled Durable
Object alarm into a new directory, reject damaged backups and non-empty targets,
and verify that incompatible upgrade checks leave metadata unchanged.
`npm run test:docker` requires a running Docker engine and Compose. It builds the
image, runs the production Compose settings in an isolated project with networking
disabled and a fake tunnel connector, verifies authenticated upload/download and
the PWA, tests graceful restart and forced process death, checks that a second
container cannot open the volume, and exercises offline device creation. Its test
containers and volume are removed afterward. CI runs this on native Linux AMD64
and ARM64 runners. Public tunnel reachability still requires a live manual check.
Manual acceptance should connect two Obsidian devices and the PWA through trusted
HTTPS, exercise initial sync and reminder editing, and verify real push delivery
after a host restart.

`sync-engine.integration.ts` runs separate real sync engines through the authenticated Worker API. Each simulated device retains its own files, settings and disk checkpoints across restarts. It checks three-device offline merging, edit/delete ordering, rename/edit races, interrupted uploads after the server commits, binary conflict preservation, and filenames such as `__proto__`. Only the Obsidian filesystem/UI surface is simulated; planning, transfer, HTTP serialization, authentication, D1 and R2 use production code.

`sync/initial-config.integration.ts` covers an empty device adopting server settings
without conflicts, subsequent concurrent settings edits, edits during download,
and interrupted first pulls across restart. `planner/initial-config-pull.test.ts` covers
the eligibility boundary, custom configuration folders and checkpoint persistence;
`manifest/initial-config-pull.test.ts` covers checkpoint validation. Physical Obsidian acceptance should start with an empty vault,
install BRAT and Crate, connect to an existing server, and verify the resulting
theme and settings after the first sync and an Obsidian reload.

## Test vault setup

Run `npm run vault:setup` to copy the Markdown baseline from `fixtures/test-vault/`
into the ignored root `test-vault/`. Existing notes are preserved, so it is safe
to repeat setup. This command always targets the repository's `test-vault/`;
`OBSIDIAN_TEST_VAULT` only changes the development build's install destination.

To restore the baseline notes, close the test vault in Obsidian and run:

```bash
npm run vault:setup -- --reset
```

Reset overwrites the sample notes, discarding edits to those notes. It preserves
extra files and `.obsidian/`, including installed plugins, credentials, and sync
state. If sync is configured, the restored notes are ordinary local changes and
may sync when the vault is reopened.

Keep reusable sample changes in `fixtures/test-vault/`. Only Markdown demo notes
belong there; do not copy `.obsidian/`, credentials, caches, or personal content
from a working vault. The screenshot baseline includes Today, Upcoming, and Home dashboards,
linked launch, travel, and reading notes, and nine reminder projects. Reminder
dates are anchored to October 4, 2026; refresh them before taking screenshots
on another day. Nested projects, recurrence, descriptions, priorities, and
completed reminders provide the other demo scenarios.

## Manual Obsidian smoke test

Run this before merging changes that touch sync orchestration, reminder parsing, markdown scanning, shadow DOM rendering, or reminder view styles:

- Run `npm run vault:setup`, then start `npm run dev`. Successful builds are copied to `test-vault/.obsidian/plugins/crate/` automatically.
- Open `test-vault` as an Obsidian vault. Enable Crate once from **Settings → Community plugins**, then reload the plugin after each build.
- Open the Reminders view and verify Inbox, Today, Upcoming, Browse, and a project detail view render in dark and light themes.
- Create, edit, complete, reorder, and delete a reminder, including one with a date, priority, project, description, and recurrence.
- Add a reminders code block and verify reading view plus live preview render and update without duplicate roots or unstyled flashes.
- Exercise sync event paths by creating, editing, deleting, and renaming a note, then confirm queued paths clear after sync.
- If push or PWA code changed, run `npm run test:pwa-preview` and manually open the preview URL.

## OAuth deployment test vault

After the Pages site and a private or public Cloudflare OAuth client are configured:

1. Build and watch with the embedded public client ID:

   ```bash
   npm run dev
   ```

   To test another OAuth client, prefix the command with `CRATE_CLOUDFLARE_OAUTH_CLIENT_ID=<client-id>`.

2. Open `test-vault` in Obsidian, enable Crate under **Settings → Community plugins**, and reload it after the build is installed.
3. Use a disposable Cloudflare test account with R2 already active. Open **Settings → Crate → Configuration → Connect with Cloudflare**.
4. Confirm the consent screen shows the expected verified publisher and exactly Workers Scripts Write, D1 Write, Workers R2 Storage Write, Memberships Read, and Account Analytics Read. Cloudflare may display the three write permissions using its legacy **Edit** label. Select exactly one account.
5. Confirm the browser lands at `/oauth/callback/`, its address bar no longer contains OAuth parameters, and Obsidian opens. If automatic launch is blocked, select **Open Obsidian**.
6. Confirm Crate creates one `crate-<16 hex>` Worker, D1 database, and R2 bucket, initializes the schema, enables the workers.dev endpoint, and connects the current device.
7. Confirm connecting alone does not upload or download vault files. Explicitly select **Crate: Sync now** in the command palette using non-critical notes only.
8. Select **Disconnect this device**, connect with Cloudflare again, and confirm Crate reuses the same Worker instead of creating another deployment.
9. Select **Authorize update** and confirm the same Worker, D1 database, R2 bucket, and Durable Object namespaces are reused.
10. For the inactive-R2 case, use an account without an active R2 subscription and confirm Crate shows the activation message rather than a generic API error.

The test creates real resources only when a person completes Cloudflare consent. Delete disposable resources manually from that test account after validation. Never paste OAuth codes, access tokens, or PKCE values into issue reports or test logs.

## Avoiding timing-dependent assertions

Freeze `Date` in unit tests that compare retry deadlines or UTC operation days,
and restore it after each test. Keep unrelated asynchronous work on real timers.

Wait for the state an action needs: mounted effects, a closed dialog and restored
focus, completed logout cleanup, or the disappearance of an outgoing screen.
A fixed sleep does not establish any of those conditions on a busy runner. Keep
elapsed-time checks when the duration itself is the contract, such as verifying
that a cancelled hold does not open a menu.

For intermediate motion, control the timeline that actually drives the effect.
Use Playwright's clock (installed before loading the app) for JavaScript springs
and fallback timers, and advance through frames with `clock.runFor`. Native CSS
transitions use a separate timeline: capture them when the state changes, pause
and seek `Animation.currentTime`, then finish them and check normal cleanup.
When comparing two animated layers, sample them at one document-timeline instant
while retaining their individual start times so a delayed layer still fails.
Check departing content while it is still painted; a fully invisible reduced-motion
layer can lose its scroll geometry before React removes it.

Exercise the modified script repeatedly in both Chromium and WebKit, without
retries, after its first passing run. Run browser suites sequentially in each
checkout so builds, focus, and output artifacts cannot interfere. A passing
repeat establishes evidence for the fix, not a guarantee that every flake is gone.

## Obsidian mock

Unit tests use two kinds of Obsidian stand-ins.

`src/test/mocks/obsidian.ts` is a DOM-backed mock. The vitest config aliases every `import { ... } from 'obsidian'` to it. When a DOM exists (for example LinkeDOM globals installed by a test), it adds Obsidian's element helpers (`createEl`, `createDiv`, `addClass`, `setText`, ...) to the DOM prototypes. It provides:

- `normalizePath`, `TAbstractFile`, `TFile` and `TFolder`
- `Notice` - records each message in `Notice.messages`; `Notice.reset()` clears them
- `Setting` with its button, toggle, text, text area and dropdown components, plus `Modal` and `PluginSettingTab`, which build real DOM nodes (`Modal` requires a DOM-enabled test)
- `Plugin` - an empty class
- `Platform` - `{ isDesktopApp: true }`
- `setIcon` and `getIcon` - stubs
- `requestUrl` - throws (must be overridden per test)

`src/test/fakes/obsidian-ui.ts` holds Node-only fakes for UI tests that run without a DOM: `FakeElement` (a minimal element tree), `MockModal`, `MockSetting` and the button, text, toggle and dropdown component mocks. A test installs them with `vi.mock('obsidian', () => createObsidianUiModule())` (or `vi.doMock`), spreading in overrides such as `Platform` when needed, and calls `resetObsidianUiMocks()` between tests. Opened modals and created settings are collected in `MockModal.instances` and `MockSetting.instances`, and notices in `noticeMessages`.

Browser tests that bundle plugin UI with esbuild use `tests/browser/support/obsidian-dialog-fixture.mjs` instead. It exports source text to interpolate into the bundle rather than redefining Obsidian helpers in each test:

- `obsidianDomHelpers` - adds `createEl`, `createDiv`, `createSpan`, `addClass`, `removeClass`, `toggleClass`, `setText`, `appendText`, `empty`, `show`, `hide`, `toggle` and `win` to `HTMLElement.prototype`; place it in the esbuild `stdin` contents
- `obsidianDialogModule` - a synthetic `obsidian` module with `setIcon`, `Setting`, `Notice` (messages in `window.notices`) and `Modal` (the open modal in `window.currentModal`); serve it from an esbuild plugin and append test-specific exports such as `Platform`
- `hostStyles` - minimal native host CSS variables and dialog, setting and button rules, with a `.theme-dark` variant

## Harnesses and patterns

Shared harnesses end in `-test-harness.ts` and are excluded from coverage.

| Harness | File | Use for |
| --- | --- | --- |
| Persistent engine | `src/sync/engine/engine-persistence-test-harness.ts` | Checkpoint persistence, discard/recovery, file transfer and shutdown ordering |
| Lightweight engine | `src/sync/engine/engine-test-harness.ts` | Sync mode selection, state transitions and isolated error handling |
| Transfer | `src/sync/transfer/transfer-test-harness.ts` | Transfer modules and other code that takes a `TransferContext` |
| Planner | `src/sync/planner/planner-test-harness.ts` | Incremental planning (`createIncrementalHarness`, `createSettings`) |
| Runtime | `src/sync/runtime/runtime-test-harness.ts` | `SyncRuntime` lifecycle (`createRuntimeHarness`, `createDeferred`, `flushMicrotasks`) |
| Worker sync devices | `src/cloudflare/worker/test-support/sync-engine-test-harness.ts` | `SyncTestDevice`, a separate device per instance against the real Worker |
| D1 query counter | `src/cloudflare/worker/test-support/d1-query-test-harness.ts` | Query budgets (`countD1Queries`, `installD1QueryCounter`) |
| Storage cost meter | `src/cloudflare/worker/test-support/storage-cost-test-harness.ts` | D1, R2 and Durable Object use per request, including alarms |

### Persistent engine harness

`createPersistentEngineHarness(transport)` in `sync/engine/engine-persistence-test-harness.ts`
initializes a real `SyncEngine`, `LocalManifest`, upload/restore journals and file
operations against the `PersistentTestVault` in `test/factories/sync-vault.ts`. Inject
responses through `ApiHttpTransport` for network-dependent cases. The shared vault
fixture is also used by Worker runtime integration tests; plugin and sync tests do not
import fixtures from Worker code.

Assert stored bytes and public engine results. Do not replace private engine fields:
file operations retain their original manifest and journal bindings. The harness
destroys engines and drains active work after each test.

### Lightweight engine harness

`createHarness()` in `sync/engine/engine-test-harness.ts` is for orchestration tests
only; it does not establish persistence behavior. It builds a real `SyncEngine` over an
in-memory vault adapter, mocked API methods pre-configured for the happy path, and a
real `LocalManifest` whose methods are wrapped in spies:

```ts
type Harness = ReturnType<typeof createHarness>;
// {
//   engine, hooks, settings, fileManager, workspace, conflictStore,
//   api: { isConfigured, getChanges, uploadFile, batchUpload, ... },   // vi.fn() mocks
//   vault: { adapter, getAbstractFileByPath, getFiles, ... },
//   localManifest: LocalManifest & { load, save, hashMatches, setEntry, ... }, // vi.spyOn
// }
```

Tests override specific mocks as needed. Helpers such as `runPeriodicCheck`,
`spyOnIncrementalSync`, `spyOnConflictRecovery` and `createNamedAbortError` live in the
same file. Sync orchestration tests observe the engine's constructor-owned manifest
through these spies.

### Transfer harness

`createTransferHarness()` in `sync/transfer/transfer-test-harness.ts` is shared by the
transfer tests (`download`, `upload`, `prepare`, `applied-content`,
`hidden-file-download`), `planner/incremental-cancellation.test.ts` and
`local/local-delete.test.ts`. It returns the mocks (`adapter`, `vault`, `fileManager`,
`api`, `localManifest`, `retryWithBackoff`, `getModifiedIso`) and a `context` that
satisfies `TransferContext`: `api` is passed as `files`, `runConcurrent` is a plain
`Promise.all`, `retryWithBackoff` calls the function once, and `encrypted()` returns
false.

### Module mocking with `vi.hoisted()`

When a module under test imports other modules that need mocking
(`planner/incremental-reconciliation.test.ts`, `transfer/download.test.ts`):

```ts
import { runIncrementalSync } from './incremental';

// Runs before any import, so the factories below can use these references.
const fileDiscoveryMocks = vi.hoisted(() => ({
  getAllVaultFiles: vi.fn(),
  isHiddenPath: vi.fn((path: string) => path.split('/').some(s => s.startsWith('.'))),
}));

vi.mock('../local/file-discovery', () => ({
  getAllVaultFiles: fileDiscoveryMocks.getAllVaultFiles,
  isHiddenPath: fileDiscoveryMocks.isHiddenPath,
}));
```

Vitest hoists `vi.mock()` calls above the imports, so the module under test sees the
mocks wherever its import appears in the file. A mock factory runs before the file's
own variables exist, so any value it references must come from `vi.hoisted()`. Use
`vi.doMock()` when a mock must apply only to modules imported after it, for example
through a dynamic `import()` inside one test.

### Context interfaces

Sync modules define narrow context interfaces (for example `TransferContext` in
`sync/transfer/types.ts` and `QueueFlushContext`) rather than depending on concrete
classes, so tests can supply partial mocks:

```ts
export interface TransferContext {
  plannedContent?: PlannedContent;
  vault: Vault;
  fileManager: { trashFile(file: TAbstractFile): Promise<void> };
  /** The engine's journaled file operations. */
  files: TransferApi;
  localManifest: TransferManifest;
  markdownBaseCache: TransferMarkdownBaseCache;
  conflictStore: TransferConflictStore;
  runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
  retryWithBackoff<T>(fn: () => Promise<T>): Promise<T>;
  getModifiedIso(path: string, fallbackMtime?: number): Promise<string>;
  /** Whether uploads are encrypted, which limits how deep a synced file can be. */
  encrypted(): boolean;
}
```

### By module type

- **Sync modules (planner, transfer, queue):** create a harness matching the context
  type, or use the shared one. Mock `runConcurrent` as a simple `Promise.all` (no
  concurrency limit needed in tests) and `retryWithBackoff` as direct invocation. Use
  `vi.hoisted()` + `vi.mock()` for cross-module dependencies.
- **Pure functions (conflict naming, ignore rules, file discovery helpers):** test
  directly with real inputs, no mocking needed. For example, `conflict/conflict.test.ts`
  tests `getConflictFileName()` and the three-way `classifyPaths()` with plain objects.
- **Engine:** use the persistent harness for manifest, journal, recovery and shutdown
  behavior, and the lightweight harness for sync mode selection, state transitions and
  isolated error handling. Trigger fallback through an expired changelog response and
  cancellation through pending adapter/API work, rather than replacing private engine
  contexts. Test pagination directly with `incremental-changelog.test.ts`; incremental
  reconciliation tests cover late local edits, guarded deletes and cursor retention.
  `engine/transfer-parity.test.ts` runs a mixed upload/delete workload through
  selected, full, incremental, automatic and forced sync using real journals and
  file operations. `transfer/delete.test.ts` checks bounded concurrency, progress,
  upload failure gates, local absence and accepted sibling cancellation.
- **Worker query budgets:** Cloudflare limits live in
  `src/cloudflare/worker/d1/platform-limits.ts`, with the docs they were checked
  against. Assert budgets against `D1_QUERIES_PER_INVOCATION`, not a literal. Count
  queries as D1 does: one per `first`/`run`/`all` and one per `db.batch()`, whatever
  its size. Pass `countD1Queries(env.DB).db` to the one invocation under test, or use
  `installD1QueryCounter(env.DB)` when the code reads the binding itself. Measure the
  worst case (stale writes, conflicts, encryption, a Reading index page in the same
  pass) and size each feature batch to leave headroom below the limit.

## Feature-specific notes

Jump to: [cleanup and route execution](#cleanup-reviews-storage-opening-and-route-execution) · [Reading pagination and checkpoints](#reading-pagination-and-checkpoint-boundaries) · [sync outcomes and reader actions](#sync-outcomes-and-reader-action-lifetimes) · [PWA hooks and runtime setup](#pwa-hooks-and-runtime-setup) · [settings identity and pending keys](#settings-identity-and-pending-change-keys) · [sync shutdown](#sync-shutdown) · [structured merge and Reading recovery](#structured-merge-and-reading-recovery).

Coverage notes, commands and manual checks for individual features live in each feature's doc under **Testing notes**:

- [reminder source recovery](reminder-source-recovery.md#testing-notes): reminder descriptions and diagnostics
- [Test Reading](read-it-later-testing.md#testing-notes): optimistic Reading actions, saved YouTube videos, Reading fetching consent
- [PWA storage recovery](pwa-storage-recovery.md#testing-notes): PWA sync coordinator
- [shared UI](ui-styling.md#testing-notes): portable visual baselines, motion continuity
- [PWA UI](pwa-ui.md#testing-notes): unified PWA settings, app updates
- [Reading UI](reading-ui.md#testing-notes): pasted links and page titles, Reading touch feedback
- [plugin UI](plugin-ui.md#testing-notes): plugin navigation parity, plugin dialog consistency
- [sync capacity](sync-capacity.md#testing-notes): reminder capacity measurements
- [backup and recovery](recovery.md#testing-notes): file history browser checks
- [deployment](deployment.md#testing-notes): connection recovery
- [encryption](e2ee-implementation.md#testing-notes): encryption acceptance, encrypted iPhone onboarding

The cross-feature notes below span sync, Reading, Reminders and the Worker. Search for the feature or test file you changed.

### Cleanup reviews, storage opening and route execution

`sync/engine/ignored-purge.test.ts` binds excluded-file cleanup to reviewed paths,
hashes, revisions and exclusions, including acknowledged batches before cancellation
and exclusive sync admission. `runtime/exclusion-cleanup.test.ts` rejects replaced
engines during review or confirmation; `ui/settings/exclusion-cleanup.test.ts`
checks confirmation and stale-review guidance.

`pwa/reminders/useReminderSync.test.ts` composes indexing progress with sync status,
including HTTP 202 followed by 200/304, terminal failure and request/session
invalidation. Normal preparation must not publish recovery attention.
`tests/browser/reading/reading-cache-recovery-test.mjs` exercises Reading's shared
single-store opener in Chromium/WebKit: unknown layouts and key configurations,
blocked/late opens, retry and version-change closure, preserving original bytes.
`tests/browser/pwa/pwa-encryption-storage-test.mjs` retains native key, attempt, logout and
push coverage for the same opener. These do not establish physical-device acceptance.

`worker/routes/admission.test.ts` checks scopes, execution destination, coordinator
wakes and projection initialization. Worker `commit-safety.integration.ts` checks
single-file and atomic-move changelog/history publication against real D1, including
rejected revisions that must leave derived state unchanged. Worker
`sync/version-coalescing.integration.ts` checks which replaced copies single, batch,
Worker-side Markdown and atomic two-file writes keep at commit-saved checkpoints, R2
removal of copies that are not kept, file history restore, keeping a checkpoint's
copy replaced within ten minutes, and the checkpoint download code for a revision that is
no longer kept. Retain the move,
upload-publication, topology and protocol integration tests when changing these
boundaries.

### Reading pagination and checkpoint boundaries

`pwa/reading/list-response.test.ts` exercises malformed page envelopes, the first page and
library queries. `reading/reading-search.integration.ts` checks title, tag and link search,
sections, paging and encrypted cards through D1, and `reading/encryption.integration.ts` checks
hashed search, upload cards and Shortcut saves end to end. `reading/capacity.integration.ts`
pages and searches 10,000- and 50,000-note libraries and bounds the rows each reads.
`tests/browser/reading/reading-cache-recovery-test.mjs` verifies that a rejected list page
preserves offline articles, pending commands and drafts in Chromium and WebKit.

`encryption/file-inventory.test.ts` and `pwa/reminders/encrypted-reminder-api.test.ts`
cover encrypted page and delta validation, advancing empty-page limits, duplicate paths,
cursor and snapshot changes, 304 polls, deltas, batch downloads of notes that change or
disappear after listing, and retention of the previous decrypted cache after rejected
loads. `pwa/reading/encrypted-routing.test.ts` checks that the Reading app sends
encrypted capture, update, retry and delete requests only as ciphertext, and
`tests/browser/pwa/pwa-reading-encryption-test.mjs` covers the encrypted Reading app end
to end in Chromium and WebKit. `encryption/encrypted-folder-lists.integration.ts` meters the rows of an
unchanged poll at 100 and 1,000 notes, deltas, and the requests and queries of a cold list.

`manifest.test.ts`, `manifest-checkpoint.test.ts` and `checkpoint-validation.test.ts`
retain entry-identity checks, checkpoint round trips, conflicting recovery metadata,
torn-write recovery and overlapping saves. Content-verifier and pending-verification
races ensure an older asynchronous read cannot replace or settle a newer baseline.

`reminders/moves.integration.ts` runs the production handlers against real D1/R2
bindings, including completed reminders, source conflicts and destination write
failures. The other reminder route and list-cache tests also use real D1/R2;
`reminders/plaintext-parity.integration.ts` compares the plaintext routes with the
shared file command used by encrypted web apps. Operation-expiry and upload-retry
integration tests exercise the shared receipt cleanup owner, including monotonic
floors and batch rollback.

`reminders/write-cost.integration.ts` uses `test-support/storage-cost-test-harness.ts`,
which meters D1, R2 and Durable Object use including the alarms a request arms
(the `X-Crate-D1-Usage` header leaves those out). It bounds rows written per
reminder edit regardless of note size, request round trips, and the rows read by a
pass with nothing to project. `reminders/list-delta.integration.ts` checks that a
web app merging deltas built from changed notes ends with the full list.

`maintenance/object-cleanup.test.ts` and `maintenance/run.test.ts` distinguish nonfatal
post-commit cleanup from scheduled failure reporting. The corresponding
`maintenance/object-cleanup.integration.ts` regression uses local D1/R2 bindings
to retain failed cleanup and its diagnostic until a successful retry. It also
drains 6,000 expired versions in 12 maintenance passes, each within the Free D1
query limit, without sorting the queue, while referenced objects survive.
`sync/history-state-restore.integration.ts` restores checkpoints through real sync and
rebuilds every surviving checkpoint of seeded random edits, across thinning and expiry,
against the state replayed from the changelog, downloading each file. It also checks
thinning buckets, list limits and the file counter. `sync/checkpoint-cost.integration.ts`
checks that saving a checkpoint reads about ten rows and that a rebuild reads the files and
only the versions kept since.

### Sync outcomes and reader action lifetimes

`engine/queue.test.ts` delays automatic result recording while a later upload is
pending, covering same-path edits, different paths and failed-upload retries.
`reading/runtime.test.ts` delays accepted host creates/processes and checks that
shutdown and replacement reads wait for them. Library tests also cover closed
admission and delayed capture completion.

`reminderDraft.test.ts` covers shared reconciliation, recurrence metadata, schedule
provenance and stable relative dates. PWA state tests retain recovery of a stored
time without a date. `tests/visual/reminder-draft.spec.ts` exercises the actual
plugin draft hook in Shadow DOM in Chromium and WebKit, including title edits,
picker changes and renders after the clock advances.

`recurrenceTimezone.test.ts` compares final submission in both hosts before draft
reconciliation, including recurrence removal/change and exact timestamps across a
DST fold. `reminder-index/calendar.test.ts` compares index, embedded queries and
shared views at midnight, timed deadlines and DST boundaries; it also advances
the clock between repository query stages to verify one consistent snapshot.

`engine/lifecycle.test.ts` distinguishes cancellation from successful completion
across ordinary, initial and forced sync, while retaining cursor and baseline
checks. `runtime/operations.test.ts` verifies that cancelled manual and automatic
work cannot publish history or checkpoints. Queue race tests use required revision
snapshots, matching production settlement. Settings and file-history tests keep
cancellation quiet and retain the controls needed to sync or resume a restore.

`reading-action-state.spec.ts` holds an article save pending while replacing or
unmounting the reader, in both the PWA document and plugin Shadow DOM hosts. Late
completion cannot clear a newer save's pending state, close its dialog or announce
an old save. `useReadingReaderActions.test.ts` covers independent mutation/sharing
channels and delayed clipboard/native-share completion across article lifetimes.

`pwa-update-test.mjs` registers installation, launch, deferred-update and command
preparation scenarios as independent named Node tests for Chromium and WebKit.
`pwa-dock-test.mjs` and `pwa-schedule-test.mjs` likewise isolate navigation,
gestures, motion, launch, empty-state and responsive checks into named scenarios.
Each owns its browser and storage; one failed scenario does not skip later cases.
Run a focused case with `node --test --test-name-pattern='<name>' tests/browser/pwa/pwa-update-test.mjs`.

The service-worker cache and push tests execute the compiled runtime, using the
same bundler as production and browser previews. `npm run typecheck:service-worker`
checks that source with WebWorker globals. Asset-version tests cover runtime-only
changes so a changed handler cannot retain the previous offline shell version.

### PWA hooks and runtime setup

`useReminderSync.test.ts` and `useReminderEditor.test.ts` render real React hooks
with LinkeDOM to check rerenders, effect cleanup, stale reads, and editor lifetime.
Browser focus and persistent storage behavior remain covered by Chromium/WebKit
checks against the built PWA.
`useReminderEditorActions.test.ts` covers delayed saves, duplicate submissions,
failed persistence and logout; `useReminderMutations.test.ts` exercises those actions
with the command hook. `runtime/encryption-setup.test.ts` verifies shutdown before
queued setup, during draining and while setup work is pending. Server-status tests exercise
cache identity, expiry, throttling and cancellation through the public runtime API.

### Settings identity and pending-change keys

`plugin/CratePlugin.test.ts` hydrates a device ID before successful and rejected
core settings writes, verifying that runtime identity survives and persisted JSON
omits it. `settings-write-lifecycle.test.ts` retains queue and shutdown coverage.
Delayed snapshot, preference and debug saves also retain newer sync cursor/history
updates, including a failed preference write followed by queued persistence.
`runtime/operations.test.ts` verifies that checkpoint attachment retains newer
history entries without mutating a previously captured settings snapshot.

`sync/queue/controller.test.ts`, `sync/queue/flush.test.ts`, `engine/selected.test.ts`, `pending-discard.test.ts`,
`engine/startup-pending.test.ts` and `engine/pending-verification.test.ts` distinguish
a literal `delete:note.md` filename from deletion of `note.md`, including renames,
startup recovery, selection, discard and newer edits during settlement.
`tests/browser/plugin/activity-diff-test.mjs` checks independent labels, previews, selection,
file actions and discard targets in Chromium and WebKit.

`worker/delivery-integrity.integration.ts` runs old-delivery/new-occurrence races
against real D1 for both push success and failure. Remaining alarm unit SQL fakes
reject unknown queries. `file-projection-parity.integration.ts` compares single
and bulk publication for duplicate identities, timed/all-day occurrences, malformed
sources and rejected revisions; bulk query-budget coverage remains separate.

`pwa/reading/useReadingArticle.test.ts` checks malformed bodies, mismatched article
IDs and out-of-folder responses on open and background refresh, preserving the
confirmed reader and cache. Typed persistence writes retain session checks.
The Reading cache-recovery, optimistic-action and encrypted-storage browser suites
exercise the extracted storage owners with native IndexedDB and Web Locks.

### Sync shutdown

`engine/checkpoint-lifecycle.test.ts` holds checkpoint writes and verification reads
through shutdown. `runtime/operations.test.ts` checks that late saves cannot update
history, persist settings, or fall back through a replacement engine.

`engine/background-lifecycle.test.ts` holds conflict writes, discovery reads and
Markdown-cache writes/deletes through shutdown. It checks that replacement engines
retain conflict metadata and accepted operations can finish their metadata writes
before the store closes. `conflict/store.test.ts` also checks queued-write draining
and rejection of mutations or late discovery after closure.

`runtime/lifecycle.test.ts` and `runtime/encryption-reset.test.ts` cancel configuration
changes both before dispatch and behind an active queued operation. They verify that
shutdown prevents remote resets, credential/settings writes, local cleanup and restart
without relying on a caller-provided abort signal.

`engine/file-operations.test.ts` checks that raw API calls retain their transport
semantics while engine operations persist interrupted uploads and guard deletion.
`runtime/file-restore.test.ts` checks restore completion against the originating
engine; `file-restore-retry.integration.ts` exercises its durable retry against the
Worker. `activity/shared-history-loader.test.ts` checks coalesced reloads, errors and
disposal through the loader's public interface. `activity/activity-status.test.ts`
covers completion progress after engine idle, stopping, conflicts and status labels.

### Structured merge and Reading recovery

File transfer and recovery tests use the [persistent engine harness](#persistent-engine-harness),
with real file operations, journals and a persistent vault; only HTTP responses and
deliberate I/O failures are substituted. `engine/selected.test.ts` and
`deletion-safety.test.ts` reload saved checkpoints to verify selected uploads/deletions,
interrupted journals and incomplete discovery.

`reading/data/obsidian-vault.test.ts` exercises file replacement, rename, exclusion and
shutdown while reads or atomic updates are pending. Reading Worker integration
coverage checks pagination, duplicates across pages, queued items, source integrity
and preserved plaintext/encrypted conflict responses.

`markdown-merge-transitions.test.ts` protects newly added, moved and removed code
fences and indented blocks, alongside ordinary prose and independent-block controls.
`sync-engine.integration.ts` checks authored conflict copies across both arrival
orders, restart, retry and a third device. `reading/library-index.integration.ts`
injects R2 failures, missing/invalid bytes and permanent parse errors into index
rebuilds; it checks duplicate-capture prevention, delayed coordinator retry, and that
edits, moves, deletions and duplicate IDs update the index in their commits without
reading R2. `reading/d1-usage.integration.ts` measures `meta.rows_read` per request
through the Worker, with 10,000 Reading notes and 10,000 other files.

`node --test tests/browser/reading/reading-cache-recovery-test.mjs` exercises the production
Reading loader and native IndexedDB in Chromium/WebKit. It covers old-server source
issues, offline articles retained through failed, incomplete and rejected list pages,
and malformed-record preservation. It is included in `npm run test:reading-browser`.
