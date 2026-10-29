# Testing

How to run each suite, where it runs in CI and the release gate come first. Notes for individual features start at [Feature-specific notes](#feature-specific-notes).

## Suites and commands

Scripts in `package.json` are the source of truth. [Framework and Config](#framework-and-config) describes the unit, Worker runtime, local server and Docker suites in more detail.

| Suite | Command | Notes |
| --- | --- | --- |
| Unit tests | `npm test` | Vitest over `src/**/*.test.ts`. One file: `npx vitest run <file>`. |
| Worker runtime | `npm run test:worker-runtime` | Builds the Worker, then runs the `*.integration.ts` suites against local D1, R2 and Durable Objects. |
| Local server | `npm run test:local-server` | Builds the Worker, then runs every `packages/server/test/*.test.mjs`. |
| Server package | `npm run test:server-package` | Packs the server and installs it through npx in an isolated cache. |
| Docker hosting | `npm run test:docker` | Needs a running Docker engine and Compose. |
| Tooling and release scripts | `npm run test:ci` | Node tests in `scripts/`, including the source-path guard and PWA browser shard coverage. The guard also fails when a `scripts/*.test.mjs` file runs from no package script. |
| Server revision | `npm run test:server-revision` and `npm run check:server-revision` | The second checks the server revision and schema against the published release baseline; it needs Git history and `gh`, so it runs beside `check:source` in CI and `release:check` rather than inside it. |
| Recovery tooling | `npm run test:recovery` | Python `unittest`. |
| Contract docs | `npm run check:contracts` | Rejects stale values in `current-contract.md`; `node scripts/check-contract-docs.mjs --write` refreshes them. |
| Static checks | `npm run lint`, `typecheck`, `typecheck:worker`, `typecheck:service-worker`, `typecheck:visual`, `deadcode`, `notices:check` | Run each as `npm run <name>`. The type-checks keep incremental state in the ignored `.generated/tsc/`. |
| Source checks | `npm run check:source` | Builds the Worker, then runs lint, the plugin, Worker and service-worker type-checks, `deadcode`, `notices:check`, `check:contracts`, `test:ci`, `test:server-revision`, `test:recovery` and `npm test`. |
| Everything except browsers | `npm run check` | `check:source`, then `test:worker-runtime` and `test:local-server`. |
| PWA preview smoke test | `npm run test:pwa-preview` | Smoke test of the built PWA preview and its asset budgets. |
| PWA browser | `npm run test:pwa-browser` | Chromium and WebKit, registered in `scripts/browser-tests.mjs`. `-- --platform=linux --shard=1/4 --list` selects and lists a CI group. One script: `node tests/browser/pwa/<name>-test.mjs`. |
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

`release:check` covers the same suites except `test:docker` and the `reproducible` rebuild, which run only in CI. A release run that reuses a successful push build of the tag commit, or of its version-only parent, skips the test jobs; see [Release verification](#release-verification).

Other workflows: `pages.yml` runs `check:docs`, the shortcut and site-deployment tests and the site build for documentation, site and shortcut changes; it deploys only for a published release or a manual run. `visual.yml` is manual, for baseline review and generation.

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

It first runs the npm advisory audit (including development dependencies, failing at low severity) and a checksum-pinned Gitleaks scan of complete fetched Git history and current source. Network failures and shallow clones fail this gate. It builds and checks the plugin, Worker and service-worker TypeScript targets, runs lint, dead-code analysis of both the full project and production dependency graph, the complete unit and Worker-runtime suites, the packed standalone server test, and the PWA preview smoke test. It then creates production plugin and Worker artifacts, enforces raw/gzip size budgets, validates manifest/version consistency and required Wrangler bindings, and checks for the OAuth deployment entry point. Chromium/WebKit tests cover PWA storage, recovery, authentication, updates, concurrency, clock boundaries and capacity.

Asset limits are defined once in `scripts/bundle-budgets.mjs`; the artifact checks and PWA smoke test use the same byte limits. Use the [local release preparation command](releases.md) to sign and upload the public shortcut, then dispatch verification. Verified plugin assets are attached to the same draft GitHub release. Publish the draft only after completing the physical-device and hosted acceptance record below.

GitHub Actions runs the same gates through `.github/workflows/verify.yml`, shared by branch/PR builds and releases. Source/security/artifact checks, Worker integration tests, Docker hosting on AMD64/ARM64, four editor shards (activity on the first, file/vault history on the second, plugin dialogs on the third), four PWA browser shards and two Reading browser groups run on Linux. Linux browser jobs use a pinned Playwright image with preinstalled browsers and OS dependencies; update its version and digest alongside the Playwright lockfile version. Three balanced native PWA shards retain macOS for native menus, font geometry and WebKit rendering/focus checks; they were the longest jobs at two shards. One visual job retains the reviewed macOS snapshot platform and also checks the native shortcut parser. These four macOS jobs stay under the hosted macOS concurrency limit, leaving a slot for overlapping runs. Capacity benchmarks remain in the gate. Automatic visual comparisons run here once; the separate visual workflow is for manual comparisons and baseline generation. New commits cancel obsolete branch verification runs.

Successful push builds upload candidate records and release assets for seven days.
Release preparation can reuse only a successful repository push run for the exact
tag commit. It rechecks that run, rejects missing or expired artifacts, refreshes
security and the published server-revision baseline, and verifies the candidate's
workflow identity, Node.js toolchain, version and artifact hashes. PR and fork runs
are excluded.

Without an exact-commit run, a release commit whose only change from its single
parent is the version can reuse that parent's successful push run for the browser,
Worker and Docker jobs. The four version files may change only their version fields
and add the new `versions.json` entry; dependencies, `minAppVersion` and every other
file must match. The source checks, plugin build, candidate record and clean-install
reproducible rebuild still run on the tag commit, and the parent run and diff are
rechecked before assets are attached. If neither run exists, the complete matrix
runs normally.

Reading checks use the same named groups locally and in CI: `test:reading-server`
covers extraction, server behavior, and shortcut contracts; `test:reading-browser`
covers the library, consent, optimistic changes, highlights, and shortcut browser
flows in two groups (`library` and `annotations`, one CI job each), one browser script at a time to avoid competing selection and focus tests.
Both groups require Chromium/WebKit and a built Worker. `test:reading` builds the
Worker and runs both groups.
File/vault history and plugin dialog browser checks also run in `release:check`.

`useReminderSync.test.ts` and `useReminderEditor.test.ts` render real React hooks
with LinkeDOM to check rerenders, effect cleanup, stale reads, and editor lifetime.
Browser focus and persistent storage behavior remain covered by Chromium/WebKit
checks against the built PWA.
`useReminderEditorActions.test.ts` covers delayed saves, duplicate submissions,
failed persistence and logout; `useReminderMutations.test.ts` exercises those actions
with the command hook. `runtime/encryption-setup.test.ts` verifies shutdown before
queued setup, during draining and while setup work is pending. Server-status tests exercise
cache identity, expiry, throttling and cancellation through the public runtime API.

Release runs resolve the tag to one commit before starting verification. Every job checks out that commit. A separate clean-install rebuild starts after the source artifacts are ready and must reproduce their plugin, CSS, Worker/PWA and source metadata hashes. Draft asset attachment waits for all required verification jobs and that rebuild. Source artifacts alone cannot authorize a release, and the original push run is rechecked before reused assets are attached.

`npm run check:source` runs everything in `npm run check` except the Worker runtime tests (`test:worker-runtime`) and the local server tests (`test:local-server`). CI runs each of its commands as a separate step so one failure does not hide the others. To inspect or reproduce a PWA browser shard:

```bash
npm run test:pwa-browser -- --platform=linux --shard=1/4 --list
npm run test:pwa-browser -- --platform=linux --shard=1/4
npm run test:pwa-browser -- --platform=macos --shard=1/2
```

Omitting both `--platform` and `--shard` runs the complete browser suite. The Linux and native macOS groups cover every script exactly once; `test:ci` checks their combined coverage and balance. Groups are balanced by the measured script durations in `scripts/browser-durations.json`, which records the source run. The current estimates use the September 30 macOS release run; refresh them from Linux CI logs after the runner change, and whenever workloads change. The runner reports each script's duration and collects ordinary test failures so one run exposes all failures in that group. Each CI shard has its own checkout; do not run shards concurrently in the same working directory.

The runner builds the Worker/PWA once, then sets `CRATE_WORKER_PREBUILT=1` for its child scripts, which verify and reuse those fresh assets. Standalone scripts build by default; tests requesting explicit asset versions (including service-worker updates) always build those versions separately. Missing prebuilt assets fail the test. `npm run test:ci` checks shard coverage and balance, runner failure handling, and metadata-independent asset versions.

`release:check` builds the Worker once, then exports `CRATE_WORKER_PREBUILT=1` so the nested `build:worker` calls (in `check:source`, the server revision, Worker runtime, local server, server package and Reading suites, and the browser runner) reuse that output. In that mode `scripts/build-worker.mjs` fails instead of reusing output that is missing, a development build, or older than any recorded Worker input in `.generated/cloudflare/server-inputs.json`. Do not export the variable in an interactive shell.

Browser files follow one naming rule, which `test:ci` enforces: entrypoints end in `-test.mjs` and imported helper modules in `-checks.mjs`; shared fixtures live in `tests/browser/support/` (the PWA preview server and assets in `support/preview/`). Every entrypoint must be in the registry, a registry group, or a package script.

PWA asset hashing and raw server-input tracking exclude Finder/Explorer metadata (`.DS_Store`, AppleDouble `._*` files, `Thumbs.db`, and `desktop.ini`). Actual source files, including other dotfiles, still affect the version.

Touch-swipe tests park the desktop cursor outside the viewport before each gesture. This prevents WebKit's layout-driven mouse-hover events from interrupting the simulated finger. The drawer test deliberately starts with a stale hover position as regression coverage. Failures save touch/pointer events, drawer state and a screenshot to `.generated/browser-failures/`; CI uploads these as `pwa-failures-<shard>`.

The individual size gates are also available as `npm run size-check:plugin` and `npm run size-check:worker`. A Cloudflare configuration change should additionally pass:

```bash
npx --yes wrangler@4.123.0 deploy --dry-run
```

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

## Framework and Config

- **Framework:** vitest
- **Config:** `vitest.config.ts`
- **Test pattern:** `src/**/*.test.ts` (co-located next to source)
- **Path aliases:** `src` -> `src/`, `obsidian` -> `src/test/mocks/obsidian.ts`

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

## Manual Obsidian Smoke Test

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

## Obsidian Mock

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

## Testing Patterns

### Persistent Engine Harness

`sync/engine/engine-persistence-test-harness.ts` initializes a real `SyncEngine`,
`LocalManifest`, upload/restore journals and file operations against
`test/factories/sync-vault.ts`. Inject responses through `ApiHttpTransport` for
network-dependent cases. The shared vault fixture is also used by Worker runtime
integration tests; plugin and sync tests do not import fixtures from Worker code.

Use this harness for checkpoint persistence, discard/recovery and shutdown ordering.
Assert stored bytes and public engine results. Do not replace private engine fields:
file operations retain their original manifest and journal bindings. The harness
destroys engines and drains active work after each test.

### Lightweight Engine Harness

`sync/engine/engine-test-harness.ts` bundles mock dependencies for isolated planning and
orchestration tests. It does not establish persistence behavior:

```ts
type Harness = {
  engine: SyncEngine;
  settings: CrateSettings;
  api: { isConfigured: Mock; getChanges: Mock; uploadFile: Mock; ... };
  vault: { adapter: MockAdapter; getAbstractFileByPath: Mock; ... };
  localManifest: { load: Mock; save: Mock; hashMatches: Mock; ... };
};
```

A `createHarness()` function wires up the engine with all mocks pre-configured for the happy path. Tests override specific mocks as needed.

### Module-Level Harness (`transfer/download.test.ts`)

For testing extracted modules (planner, transfer, queue), a lighter harness creates just the context interface:

```ts
function createTransferHarness() {
  const adapter = { readBinary: vi.fn(), stat: vi.fn(), ... };
  const vault = { adapter, getAbstractFileByPath: vi.fn(), ... };
  const api = { uploadFile: vi.fn(), downloadFile: vi.fn(), ... };
  const localManifest = { hashMatches: vi.fn(), setEntry: vi.fn(), ... };
  return {
    adapter, vault, api, localManifest,
    context: { vault, api, localManifest, runConcurrent, retryWithBackoff, ... },
  };
}
```

### Module Mocking with `vi.hoisted()` (`planner/incremental-reconciliation.test.ts`, `transfer/download.test.ts`)

When a module under test imports other modules that need mocking:

```ts
// 1. Define mocks in hoisted scope (runs before imports)
const fileDiscoveryMocks = vi.hoisted(() => ({
  getAllVaultFiles: vi.fn(),
  isHiddenPath: vi.fn((path: string) => path.split('/').some(s => s.startsWith('.'))),
}));

// 2. Replace the module
vi.mock('../local/file-discovery', () => ({
  getAllVaultFiles: fileDiscoveryMocks.getAllVaultFiles,
  isHiddenPath: fileDiscoveryMocks.isHiddenPath,
}));

// 3. Import the module under test AFTER vi.mock()
import { runIncrementalSync } from './incremental';
```

Key: `vi.hoisted()` ensures mock references are available before module evaluation. The import of the module under test must come after `vi.mock()` calls.

### Context Interface Pattern

Sync modules define narrow context interfaces (e.g., `TransferContext` and `QueueFlushContext`) rather than depending on concrete classes. This makes tests easy to write with partial mocks:

```ts
// Module defines what it needs
export interface TransferContext {
  vault: Vault;
  api: TransferApi;
  localManifest: TransferManifest;
  runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
  retryWithBackoff<T>(fn: () => Promise<T>): Promise<T>;
  getModifiedIso(path: string, fallbackMtime?: number): Promise<string>;
}

// Test provides minimal implementation
const context = {
  vault: vault as never,
  api,
  localManifest,
  runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(t => t())),
  retryWithBackoff: async (fn) => fn(),
  getModifiedIso: async () => '2026-01-01T00:00:00.000Z',
};
```

## Writing Tests by Module Type

### Sync modules (planner, transfer, queue)

- Use the context interface pattern - create a harness matching the context type
- Mock `runConcurrent` as simple `Promise.all` (no concurrency limit needed in tests)
- Mock `retryWithBackoff` as direct invocation
- Use `vi.hoisted()` + `vi.mock()` for cross-module dependencies

### Pure functions (conflict, encoding, hasher, file-discovery)

- Test directly with real inputs, no mocking needed
- Example: `conflict.test.ts` tests `getConflictFileName()` and `detectConflicts()` with plain objects

### Engine (integration)

- Use the persistent harness for manifest, journal, recovery and shutdown behavior.
- Use the lightweight mock harness for sync mode selection, state transitions and
  isolated error handling.
- Trigger fallback through an expired changelog response and cancellation through
  pending adapter/API work, rather than replacing private engine contexts.
- Test pagination directly with `incremental-changelog.test.ts`; incremental
  reconciliation tests cover late local edits, guarded deletes and cursor retention.
- `engine/transfer-parity.test.ts` runs a mixed upload/delete workload through
  selected, full, incremental, automatic and forced sync using real journals and
  file operations. `transfer/delete.test.ts` checks bounded concurrency, progress,
  upload failure gates, local absence and accepted sibling cancellation.

## Feature-specific notes

Coverage notes, commands and manual checks for individual features live in each feature's doc under **Testing notes**:

- [reminder source recovery](reminder-source-recovery.md#testing-notes): reminder descriptions and diagnostics
- [Test Reading](read-it-later-testing.md#testing-notes): optimistic Reading actions, saved YouTube videos, Reading fetching consent
- [PWA storage recovery](pwa-storage-recovery.md#testing-notes): PWA sync coordinator
- [shared UI](ui-styling.md#testing-notes): unified PWA settings, app updates, portable visual baselines, pasted links and page titles, Reading touch feedback, motion continuity, plugin navigation parity, plugin dialog consistency
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
Worker-side Markdown and atomic two-file writes keep, the 60-minute window for large
files, R2 removal of copies that are not kept, file history restore and the checkpoint
download code for a revision that is no longer kept. Retain the move,
upload-publication, topology and protocol integration tests when changing these
boundaries.

### Reading pagination and checkpoint boundaries

`pwa/reading/list-response.test.ts` exercises malformed page envelopes and cursors,
cursor cycles, and cumulative item, issue and request limits.
`tests/browser/reading/reading-cache-recovery-test.mjs` verifies that rejected pagination
preserves the confirmed cache, offline articles and pending commands in Chromium
and WebKit.

`encryption/file-inventory.test.ts`, `pwa/reading/encrypted-api.test.ts` and
`pwa/reminders/encrypted-reminder-api.test.ts` cover encrypted page validation, advancing
empty-page limits, duplicate paths, cursor/sequence changes and retention of the
previous decrypted cache after rejected loads.

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
drains 6,000 expired versions in 13 maintenance passes, each within the Free D1
query limit, without sorting the queue, while referenced objects survive.
`sync/checkpoint-cleanup.integration.ts` checks that index rewrites delete evicted,
expired and unpublished checkpoint inventories, including with a concurrent index
writer, and that the maintenance sweep continues across passes while a backlog remains.

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

Sync orchestration tests observe the engine's constructor-owned manifest through
`engine-test-harness.ts`. File transfer and recovery tests use
`engine-persistence-test-harness.ts`, with real file operations, journals and a
persistent vault; only HTTP responses and deliberate I/O failures are substituted.
`engine/selected.test.ts` and `deletion-safety.test.ts` reload saved checkpoints to
verify selected uploads/deletions, interrupted journals and incomplete discovery.

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
issues, retained offline articles/list entries, definitive deletion, quota rollback
and malformed-record preservation. It is included in `npm run test:reading-browser`.
