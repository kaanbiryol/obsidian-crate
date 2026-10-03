# Testing

## Structured merge and Reading recovery

`markdown-merge-transitions.test.ts` protects newly added, moved and removed code
fences and indented blocks, alongside ordinary prose and independent-block controls.
`sync-engine.integration.ts` checks authored conflict copies across both arrival
orders, restart, retry and a third device. `reading-projection-recovery.integration.ts`
injects R2 failures, missing/invalid bytes, legacy error rows and permanent parse
errors; it checks duplicate-capture prevention, healthy-source progress, retained
identity and delayed coordinator retry.

`node --test scripts/reading-cache-recovery.browser.test.mjs` exercises the production
Reading loader and native IndexedDB in Chromium/WebKit. It covers old-server source
issues, retained offline articles/list entries, definitive deletion, quota rollback
and malformed-record preservation. It is included in `npm run test:reading-browser`.

## Optimistic Reading actions

After building the Worker, run `node --test scripts/reading-optimistic.browser.test.mjs`
for Chromium and WebKit coverage of immediate link saves, continued editing during
delayed requests, tags and highlight notes, offline changes, and conflict rollback.
The tests use the built PWA, native IndexedDB/Web Locks, and the real local Worker.
Chromium also verifies offline reload; WebKit verifies offline use in the current
document. Physical installed-app acceptance remains a device check.

Reading persists changes locally before updating the UI and sends them in the
background, like Reminders. Unsent edits combine while preserving their original
preconditions; edits made during a request queue behind its immutable request body.
Interrupted requests get the same short, bounded retries as Reminders, using those
exact bytes and their original operation identity. Automatic retry limits survive
foreground events and reload; **Settings → Sync and device → Refresh all** can
retry uncertain changes explicitly. The browser test covers this against real
server receipts, including repeated lost acknowledgements.
`useReadingSession.test.ts` and `useReadingSync.test.ts` use real React effects and
rerenders. `useLocalReadingArticle.test.ts` covers competing opens, Back, library
replacement, unmount and late update completions.
Rejected edits and their dependents remain available for export in settings.
New links appear immediately; editing them becomes available when extraction finishes and the server
publishes their Markdown note. Article extraction still requires a connection.

## PWA sync coordinator

After building the Worker, run `CRATE_PWA_PREBUILT=1 node scripts/pwa-sync-coordinator-test.mjs`.
It exercises the built app in Chromium and WebKit with native IndexedDB and localStorage:
Reading dispatch while only Reminders is rendered, reminder dispatch while only Reading
is rendered, a Reading refresh failure that does not block reminders, shared header
status, and paused queues retained through reload and resumed without opening their
screens, plus immediate logout and remote cleanup feedback with the other screen
unmounted. A blocked Reminders screen chunk must leave sync, settings and Reading
usable. The preview supplies synthetic domain APIs; existing receipt and auth recovery
suites cover their separate server and session guarantees. Settings opens sync details
without mounting the other feature's screen. Physical installed-app acceptance remains
a device check.

## Unified PWA settings

After building the Worker, run `CRATE_PWA_PREBUILT=1 node scripts/pwa-settings-test.mjs`
for Chromium and WebKit coverage of both settings entry points, retained view/search
and focus, shared theme and preferences, Reading launch destinations, explicit-link
precedence, shortcut navigation, pending Reading warnings from Reminders, and shared
logout. The test uses the built client, local synthetic APIs, and native browser
storage; screenshots include light/dark, 320px phone, and desktop layouts.
The navigation checks cover Default tab in Tabs, always-visible About and Sync
and device sections, always-visible storage and version tools, conditional tab
reset, touch targets, retained settings scroll/focus, native Back/Forward, the
header Back action, Escape, and shared edge-gesture eligibility. Motion checks
sample full-page push/pop frames, including the moving header, opaque surface,
stationary parent, fixed header during scrolling, and restored scroll/focus. Desktop engines
can check history and gesture arbitration; the interactive OS swipe preview and
cancellation still need an installed iPhone check. `pushed-screen-history.test.ts`
covers preserving an underlying feature, repeated visits and quick reopening.
Theme checks cover one document update with both features mounted, system-theme
changes, explicit overrides, settings close/reopen, feature switching, and native
cross-tab updates including invalid or removed preferences. Early HTML theme
application before React loads is covered by `scripts/pwa-startup-empty-test.mjs`.
Run the storage-safety, sheet-interaction, and Reading shortcut browser checks for
cleanup failures, touch/keyboard behavior, and real local pairing. Physical iPhone
keyboard, VoiceOver, installed-sheet gestures, and safe areas remain device checks.

Run `node scripts/pwa-sheet-field-test.mjs` for Chromium/WebKit coverage of
**Save a link** focus, keyboard geometry, and caret visibility during opening,
closing, interrupted dragging, and retargeted keyboard movement. It also checks
caret restoration with reduced motion and draft preservation across reopening.
The keyboard viewport is simulated; native caret painting and software-keyboard
behavior still require an installed-app check on an iPhone.

## App updates

Run `node scripts/pwa-update-notice-test.mjs` for Chromium/WebKit checks of global
version detection from a Reading-only launch, foreground polling, navigation,
direct header updates, offline blocking, Settings access, and light/dark mobile layouts.
Screenshots are written to `test-results/update-notice/`.
`node scripts/pwa-update-test.mjs` exercises real service-worker preparation,
activation, failed/slow checks, launch updates, pending writes, and other tabs.
Both are included in `npm run test:pwa-browser`. Installed iPhone safe areas,
app suspension, and VoiceOver announcements still require physical-device checks.

## Framework and Config

- **Framework:** vitest
- **Config:** `vitest.config.ts`
- **Test pattern:** `src/**/*.test.ts` (co-located next to source)
- **Path aliases:** `src` -> `src/`, `obsidian` -> `src/test/mocks/obsidian.ts`

```bash
npm test                                  # run all tests
npm run test:worker-runtime               # run D1/R2/Durable Object tests in the Workers runtime
npx vitest run src/sync/planner-full.test.ts   # single test file
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
and rejection of downloads with an invalid checksum. `npm run test:server-package`
installs a packed artifact through npx in an isolated cache and exercises real
HTTP and storage across changing public URLs, using a fake connector.
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

`sync-initial-config.integration.ts` covers an empty device adopting server settings
without conflicts, subsequent concurrent settings edits, edits during download,
and interrupted first pulls across restart. `initial-config-pull.test.ts` covers
the eligibility boundary, custom configuration folders, checkpoint persistence
and validation. Physical Obsidian acceptance should start with an empty vault,
install BRAT and Crate, connect to an existing server, and verify the resulting
theme and settings after the first sync and an Obsidian reload.

## Reminder capacity measurements

```bash
npm run benchmark:reminders
```

This repeatable local benchmark also runs as part of the Worker integration suite. Its verbose reporter emits structured measurements for 1,000 and 10,000 reminders: warm folders with one reminder per file, and cold folders with ten reminders per file. It verifies complete, unique results, cache-warming progress, and unchanged responses. It records wall time, response bytes and prepared SQL statements; it does not measure hosted CPU limits, real network latency, browser rendering or device memory.

On September 7, 2026, using Node 24.0.0 and local workerd after the cache decoding improvement:

| Scenario | Files | Reminders | Warm response range | Response bytes | Cold indexing requests |
| --- | ---: | ---: | ---: | ---: | ---: |
| One reminder per file | 1,000 | 1,000 | 13–25 ms | 288,930 | Not measured |
| One reminder per file | 10,000 | 10,000 | 117–133 ms | 2,898,930 | Not measured |
| Ten reminders per file | 100 | 1,000 | 17–28 ms | 276,240 | 5 |
| Ten reminders per file | 1,000 | 10,000 | 80–98 ms | 2,771,940 | 50 |

Warm lists prepared three SQL statements; unchanged requests prepared one and took 2–21 ms across these cases. Cold indexing took 137 ms and 1,772 ms of local request time, respectively. The browser additionally honors a one-second delay between warming requests: the 50-request case therefore incurs about 49 seconds of deliberate waiting, plus request time. These are local samples, not latency guarantees or a production capacity certification.

The full list still grows with folder size. Before promising support for large folders, repeat the 1,000/10,000 cases on a disposable hosted deployment and physical devices, recording Worker CPU/errors, D1 rows read, transfer size, time to first usable screen, scroll responsiveness and memory. If large folders are a release requirement, use these measurements to set the supported limit and evaluate a paginated per-reminder index; do not infer hosted support from the local pass.

Hosted capacity tests spend the account's shared D1 quota, even in a disposable
database. Run write-heavy fixtures locally by default. Before any hosted write
test, agree on a total row-write budget and account headroom; without one, the
hosted write budget is zero. Include index updates, reminder projections,
background jobs, retries and reset/deletion writes in the estimate. Do not infer
row-write cost from the number of requests or notes. Keep the 1,000/10,000-reminder
fixtures off a daily-quota-constrained account. For disposable resource cleanup,
delete the database through the resource API instead of resetting its rows just
to prepare it for deletion; empty R2 separately without D1 mutations.

### Browser list capacity

`npm run benchmark:pwa` measures the production PWA with a local synthetic API in Chromium and WebKit at a 390 × 844 viewport. It is also included in `test:pwa-browser`. The test checks page navigation, off-page editing, saved changes, complete reorder payloads and bounded rendered rows at 1,000 and 10,000 reminders. The fixture deliberately stresses a single Inbox; it does not claim that 10,000 reminders fit the real per-file indexing limits.

The PWA now pages active, completed and date-grouped lists in batches of 200. A native page selector reaches any range. Paging affects rendered rows only: counts, cache, edits and reorder validation retain the full data. Obsidian's plugin views keep their existing behavior.

Cards within each page remain rendered offscreen. Avoid `content-visibility: auto`
on reminder rows: fast scrolling can expose unpainted cards and replace estimated
row heights mid-scroll. Run `node scripts/pwa-reminder-scroll-test.mjs` for
Chromium/WebKit checks of Today and Upcoming rendering before scrolling, rapid
scroll reversals with variable-height cards, and completion scroll anchoring.
Installed iPhone momentum scrolling still requires a physical-device check.

| Local 10,000-reminder Inbox | Before paging | With paging |
| --- | ---: | ---: |
| Chromium: first usable list | 7.24 s | 0.227 s |
| WebKit: first usable list | 23.07 s | 0.282 s |
| Mounted cards | 10,000 | 200 |
| DOM elements | 160,114 | 3,372 |

These are unthrottled local samples from September 7, 2026, with service workers disabled, not physical-device or network guarantees. The server still returns the full folder response. Reordering now accepts up to 10,000 IDs while retaining the 1 MiB request limit, stale-order checks and idempotent receipts; a real D1/R2 regression verifies reordering inside a 1,000-reminder project without changing other rows.

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

It first runs the npm advisory audit (including development dependencies, failing at low severity) and a checksum-pinned Gitleaks scan of complete fetched Git history and current source. Network failures and shallow clones fail this gate. It builds and checks both TypeScript targets, runs lint, dead-code analysis of both the full project and production dependency graph, the complete unit and Worker-runtime suites, and the PWA preview smoke test. It then creates production plugin and Worker artifacts, enforces raw/gzip size budgets, validates manifest/version consistency and required Wrangler bindings, and checks for the OAuth deployment entry point. Chromium/WebKit tests cover PWA storage, recovery, authentication, updates, concurrency, clock boundaries and capacity.

Asset limits are defined once in `scripts/bundle-budgets.mjs`; the artifact checks and PWA smoke test use the same byte limits. Use the [local release preparation command](releases.md) to sign and upload the public shortcut, then dispatch verification. Verified plugin assets are attached to the same draft GitHub release. Publish the draft only after completing the physical-device and hosted acceptance record below.

GitHub Actions runs the same gates through `.github/workflows/verify.yml`, shared by branch/PR builds and releases. Source/security/artifact checks, Worker integration tests, Docker hosting on AMD64/ARM64, four editor shards (activity on the first, file/vault history on the second), and four PWA browser shards run on Linux. Linux browser jobs use a pinned Playwright image with preinstalled browsers and OS dependencies; update its version and digest alongside the Playwright lockfile version. Two balanced native PWA shards retain macOS for native menus, font geometry and WebKit rendering/focus checks. Two visual shards retain the reviewed macOS snapshot platform. The Reading browser job runs on macOS and checks the native shortcut parser before its browser suite. These five macOS jobs fit the hosted macOS concurrency limit. Capacity benchmarks remain in the gate. Automatic visual comparisons run here once; the separate visual workflow is for manual comparisons and baseline generation. New commits cancel obsolete branch verification runs.

Successful push builds upload candidate records and release assets for seven days.
Release preparation can reuse only a successful repository push run for the exact
tag commit. It rechecks that run, rejects missing or expired artifacts, refreshes
security and the published server-revision baseline, and verifies the candidate's
workflow identity, Node.js toolchain, version and artifact hashes. PR and fork runs
are excluded. If no eligible run exists, the complete matrix runs normally.

Reading checks use the same named groups locally and in CI: `test:reading-server`
covers extraction, server behavior, and shortcut contracts; `test:reading-browser`
covers the library, consent, optimistic changes, highlights, and shortcut browser
flows, one browser script at a time to avoid competing selection and focus tests.
Both groups require Chromium/WebKit and a built Worker. `test:reading` builds the
Worker and runs both groups.
File/vault history browser checks also run in `release:check`.

`useReminderSync.test.ts` and `useReminderEditor.test.ts` render real React hooks
with LinkeDOM to check rerenders, effect cleanup, stale reads, and editor lifetime.
Browser focus and persistent storage behavior remain covered by Chromium/WebKit
checks against the built PWA.

Release runs resolve the tag to one commit before starting verification. Every job checks out that commit. A separate clean-install rebuild starts after the source artifacts are ready and must reproduce their plugin, CSS, Worker/PWA and source metadata hashes. Draft asset attachment waits for all required verification jobs and that rebuild. Source artifacts alone cannot authorize a release, and the original push run is rechecked before reused assets are attached.

`npm run check:source` runs everything in `npm run check` except the Worker runtime tests. To inspect or reproduce a PWA browser shard:

```bash
npm run test:pwa-browser -- --platform=linux --shard=1/4 --list
npm run test:pwa-browser -- --platform=linux --shard=1/4
npm run test:pwa-browser -- --platform=macos --shard=1/2
```

Omitting both `--platform` and `--shard` runs the complete browser suite. The Linux and native macOS groups cover every script exactly once; `test:ci` checks their combined coverage and balance. Groups are balanced by the measured script durations in `scripts/pwa-browser-durations.json`, which records the source run. The current estimates use the September 30 macOS release run; refresh them from Linux CI logs after the runner change, and whenever workloads change. The runner reports each script's duration and collects ordinary test failures so one run exposes all failures in that group. Each CI shard has its own checkout; do not run shards concurrently in the same working directory.

The runner builds the Worker/PWA once, then sets `CRATE_PWA_PREBUILT=1` for its child scripts to reuse those fresh assets. Standalone scripts build by default; tests requesting explicit asset versions (including service-worker updates) always build those versions separately. Missing prebuilt assets fail the test. `npm run test:ci` checks shard coverage and balance, runner failure handling, and metadata-independent asset versions.

PWA asset hashing and raw server-input tracking exclude Finder/Explorer metadata (`.DS_Store`, AppleDouble `._*` files, `Thumbs.db`, and `desktop.ini`). Actual source files, including other dotfiles, still affect the version.

Touch-swipe tests park the desktop cursor outside the viewport before each gesture. This prevents WebKit's layout-driven mouse-hover events from interrupting the simulated finger. The drawer test deliberately starts with a stale hover position as regression coverage. Failures save touch/pointer events, drawer state and a screenshot to `.generated/browser-failures/`; CI uploads these as `pwa-failures-<shard>`.

The individual size gates are also available as `npm run size-check:plugin` and `npm run size-check:worker`. A Cloudflare configuration change should additionally pass:

```bash
npx --yes wrangler@4.123.0 deploy --dry-run
```

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
dates are anchored to September 18, 2026; refresh them before taking screenshots
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
7. Confirm connecting alone does not upload or download vault files. Explicitly select **Crate: Sync - sync now** in the command palette using non-critical notes only.
8. Select **Disconnect this device**, connect with Cloudflare again, and confirm Crate reuses the same Worker instead of creating another deployment.
9. Select **Authorize update** and confirm the same Worker, D1 database, R2 bucket, and Durable Object namespaces are reused.
10. For the inactive-R2 case, use an account without an active R2 subscription and confirm Crate shows the activation message rather than a generic API error.

The test creates real resources only when a person completes Cloudflare consent. Delete disposable resources manually from that test account after validation. Never paste OAuth codes, access tokens, or PKCE values into issue reports or test logs.

## Public-release acceptance

Keep candidate-specific acceptance records and artifact checksums outside version control. Complete the checks below before publishing.

Record the Obsidian version, operating-system version, and result for each device. Complete this matrix against the exact release assets before publishing:

- Run at least one pass on Obsidian 1.13.0, the version declared in `manifest.json`. If it is unavailable or any required flow fails, raise `minAppVersion` and the matching `versions.json` entry to the oldest version actually tested.
- Use a Cloudflare account that is not owned by or a member of the OAuth-client publisher. Confirm the verified publisher and exactly Workers Scripts Write, D1 Write, Workers R2 Storage Write, Memberships Read, and Account Analytics Read.
- Install `main.js`, `manifest.json`, and `styles.css` from the prepared release assets into a clean desktop vault. Complete OAuth, explicit initial upload, restart, reconnect, and server update.
- On a physical iOS device, select **Connect with Cloudflare**, then **Open Cloudflare**. Complete authorization in the browser and confirm the callback reopens Obsidian (or **Open Obsidian** does). Join the existing server, then select **Crate: Sync - sync now** in the command palette. Create, edit, rename, and delete Markdown and binary files; preserve a concurrent-edit conflict; background and resume Obsidian; then disable and re-enable Crate.
- Repeat the same Cloudflare sign-in and existing-server flow on a physical Android device.
- On both mobile platforms, create, edit, complete, reorder, and delete reminders. Install the reminders web app, enable push, receive both a test notification and a scheduled reminder, verify sign-out, and confirm a signed-out browser cannot use the previous session.
- On both mobile platforms, exercise the settings tab: sync controls and exclusions, reminder and notification options, web app **Open app**, Reading **Open web reading**, connected devices, Cloudflare usage and dashboard, and recovery dialogs. Check link and clipboard fallbacks from the same phone. If Reading is enabled, test its library and a new browser setup link. Record any settings that cannot be reached or changed.
- Confirm **Disconnect this device** removes only the local credential, while explicit Cloudflare resource deletion removes the remote copy as documented.

## Obsidian Mock

`src/test/mocks/obsidian.ts` provides stubs for Obsidian APIs:

- `TFolder` - class with `path` property
- `Notice` - no-op constructor
- `Platform` - `{ isDesktopApp: true }`
- `requestUrl` - throws (must be overridden per test)

The vitest config aliases `obsidian` imports to this mock file, so all `import { ... } from 'obsidian'` statements resolve to the mock at test time.

## Testing Patterns

### The Harness Pattern (engine.test.ts)

For integration-level tests of `SyncEngine`, a typed `Harness` object bundles all mock dependencies:

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

### Module-Level Harness (`transfer-download.test.ts`)

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

### Module Mocking with `vi.hoisted()` (`planner-incremental-reconciliation.test.ts`, `transfer-download.test.ts`)

When a module under test imports other modules that need mocking:

```ts
// 1. Define mocks in hoisted scope (runs before imports)
const fileDiscoveryMocks = vi.hoisted(() => ({
  getAllVaultFiles: vi.fn(),
  isHiddenPath: vi.fn((path: string) => path.split('/').some(s => s.startsWith('.'))),
}));

// 2. Replace the module
vi.mock('./file-discovery', () => ({
  getAllVaultFiles: fileDiscoveryMocks.getAllVaultFiles,
  isHiddenPath: fileDiscoveryMocks.isHiddenPath,
}));

// 3. Import the module under test AFTER vi.mock()
import { runIncrementalSync } from './planner';
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

- Uses the full Harness type with all dependencies mocked
- Tests the orchestration logic (sync mode selection, state transitions, error handling)

## Portable visual baselines

`npm run test:visual` fixes time, timezone and browser locale. Native time controls still use the operating system's 12/24-hour preference, so screenshots normalize their width and mask only the native time-input region. The time value is asserted independently, the surrounding labels/layout keep the existing 0.1% pixel threshold, and project, repeat-tab and time keyboard behavior run in separate tests. Baseline updates should affect only the intended time-control region; inspect mobile and desktop examples before accepting them. Browser zoom remains enabled in production.

## File history browser checks

Run `npm run build && npm run test:file-history-browser` for the production file-history renderer in Chromium and WebKit, at desktop/mobile widths in light and dark themes. The harness covers chronological history, direct file access including deleted files and files with no earlier versions, desktop/mobile version navigation, keyboard selection, compact no-difference previews, saved text escaping, local comparisons, deletion filtering, preview retry, and restore confirmation/cancellation. Screenshots are written to `.generated/file-history/`. Obsidian supplies the real modal focus shell; verify native focus/dismissal and physical-device navigation separately.

## Pasted links and page titles

Run `npm run test:page-titles` for the production build, lookup/transport unit tests,
authenticated Worker-runtime tests, and Chromium/WebKit editor tests. The browser
cases run the shared editor in both PWA and plugin hosts; plugin title/description
fixtures use Shadow DOM. The browser suite is also included in `test:visual` and
`test:lexical`, while unit and Worker cases join their normal test commands.

Coverage includes automatic lookup without preferences or browser storage; title and description
pastes; selected labels; Unicode/entity/Markdown handling; caret and focus retention;
undo/redo; concurrent and out-of-order responses; external loads, remounts, read-only
state, and composition while a request is pending. Failure cases cover
network errors, unsupported servers, malformed responses, empty titles, and deadlines.
Worker tests cover authentication, expired/revoked sessions, rate limits, public URL
validation on every redirect, request/body size bounds, stream cancellation, and
ignoring title-like text in scripts, comments, attributes, and other raw-text elements.
Outbound page responses are controlled fixtures; these tests do not contact websites
or establish physical-device, installed-PWA, or hosted-network acceptance.

Playwright starts a private static gallery for each visual run. It snapshots the
built plugin stylesheet before bundling the gallery, chooses an available loopback
port, and never reuses the live preview. Rebuilding or removing `dist/` after that
snapshot cannot reload or break active fixtures. Build the plugin before starting
tests; a missing stylesheet fails with an actionable error. Source changes made
after the snapshot require a new run.

The gallery snapshot stays in `.generated/visual-runs/<run-id>/`; results and HTML
reports stay in `test-results/visual-<run-id>/` and
`playwright-report/visual-<run-id>/`. These ignored directories can be removed after
review. `npm run preview:ui` remains the live editing server on port 8790.
`npm run test:ci` checks that concurrent gallery snapshots retain their own styles
even after the input stylesheet changes or disappears.

Whole-vault history restore is covered by `src/sync/history-restore.test.ts`,
`src/sync/runtime-history-restore.test.ts`, and
`src/cloudflare/worker/history-state-restore.integration.ts`. The file-history browser
harness also checks the checkpoint action, per-file preview, cancellation, busy
controls, unavailable versions, and retry in both engines and viewport sizes.
History rows show second-level timestamps; restore-point IDs appear in the confirmation. Browser checks
cover selecting same-minute points, exact-point text diffs, addition/removal
previews, escaped text, and ignoring stale previews when switching files.
The History tab retains expandable sync entries and per-file history actions. One
**Browse vault history** button opens the dedicated three-pane screen. The harness
checks file actions, expanded rows and focus across refresh, lazy loading,
stacked dialog dismissal and focus return to the preserved activity list, desktop
columns, mobile pane navigation, selected restore targets,
current-vault comparisons even for the oldest checkpoint, matching-state messages,
explicit comparison refresh, load retry, stale sync requests, and selection
stability during refresh. `engine-history.test.ts`,
`history-comparison.test.ts`, and `runtime-history-comparison.test.ts` cover
complete-inventory comparisons, unsynced edits, hidden configuration, exclusions,
incomplete reads, missing saved states, byte verification, preview limits, and
connection changes.
Restore opens a compact confirmation directly from Vault history. Browser checks
cover transparent footer actions, current-file counts, cancellation during preflight,
unavailable versions, unchanged states, busy dismissal guards, and failed-restore
retry with a fresh preflight. No extra diff review or second confirmation appears.
For native Obsidian acceptance, verify dismissal is blocked while restoring,
restore an edit/deletion/rename/addition checkpoint in a disposable synced vault,
and confirm another device converges. Interrupt a restore and restart Obsidian to
verify automatic sync stays off and the local recovery copies remain available.

Shared-checkpoint coverage also exercises a second device discovering and restoring
another device's checkpoint without its local history, retained attachments over
256 KB, concurrent publication, lost index-write responses, page-generation races,
20-entry limits, expiry, metadata cleanup, and vault-token authorization. Run
`npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/history-state-restore.integration.ts`
for those real D1/R2/DO checks. Hosted and physical-device acceptance still requires
updating the server and plugin on both devices and restoring from the second one.


## Connection recovery

In **Crate → Account and devices**, select **Reconnect** to check Cloudflare
access and the device credential together. With a valid device credential, verify
that reconnect preserves it and does not transfer files or publish a server update.
With a rejected credential, verify that reconnect registers and checks a replacement
without requiring **Disconnect this device**. Expired Cloudflare authorization
should open sign-in and resume reconnect after the callback. Network or verification
failures must not show success. Self-hosted reconnect should accept a new pairing
code at the saved address and keep the existing local connection on failure.

Focused coverage: `src/cloudflare/plugin-integration.test.ts`,
`src/cloudflare/deployment-service.test.ts`,
`src/sync/self-hosted-connection.test.ts`, and the affected settings tests.
Browser OAuth handoff and real hosted credentials still require manual acceptance.

## Reading touch feedback

Run `node scripts/pwa-project-transition-test.mjs` for project navigation and
card feedback in Chromium/WebKit. It checks resting card styles at the history
push after held presses and native taps, including grouped and nested projects
in both themes. Verify the browser-owned swipe-back preview on an installed
iPhone separately.

Run `node scripts/reading-touch-test.mjs` for Chromium/WebKit checks of article
open/Back cycles in both themes, retained hover, and keyboard focus restoration.
Chromium also exercises native touch cancellation and scrolling, plus a forced
stale `:active` state. The test uses the built PWA with synthetic Reading APIs
and is included in `npm run test:pwa-browser`. Installed iPhone behavior still
requires device verification.

Run `node scripts/shared-press-feedback-test.mjs` for the shared controls’ press
contract in Chromium and WebKit, in both document and Shadow DOM hosts. It covers
release outside an inert control, cancellation, movement into scrolling, window
blur, keyboard activation, disabled controls, persistent toggle selection, and
native input editing. It is included in `npm run test:pwa-browser`.

## Motion continuity

Use `node scripts/visual-test-run.mjs [Playwright arguments]` for gallery tests.
The launcher assigns an isolated output directory and port before starting Playwright;
the configuration itself performs no network work, so static analysis and
`npx playwright test --list` can read it directly. Preview build/serve lifecycle
remains in `scripts/visual-preview.mjs`.

`node scripts/pwa-feature-switcher-test.mjs` checks opaque feature dissolves,
mid-fade reversals, delayed animation cleanup, lazy-loading surfaces, immediate
reduced-motion switching and focus in Chromium/WebKit. Build the Worker first,
or let its preview harness build it.

After `npm run build:plugin`, run
`node scripts/visual-test-run.mjs tests/visual/motion.spec.ts tests/visual/motion-webkit.spec.ts --workers=1`
for shared empty/list reversals, immediate input, stable list geometry, progress
fill geometry, restrained checkmarks and reduced motion. The plugin fixture uses
Shadow DOM and also checks stationary centered dialogs. Actual installed iPhone
and Obsidian rendering still requires device verification.

## Reading fetching consent

After `npm run build:worker`, run
`node --test scripts/reading-consent.browser.test.mjs` for Chromium and WebKit
coverage of the full article save disclosure, automatic extraction, legacy permission migration,
and library access after fetching is disabled. Light/dark phone screenshots are
written to `test-results/reading-consent/`. This uses a real local Worker; physical
iPhone keyboard and VoiceOver checks remain separate.

Shared feature regression coverage: `src/plugin/feature-settings.test.ts` checks
server-first updates, offline failures, and cross-device reconciliation;
`src/cloudflare/worker/feature-policy.integration.ts` checks stale edits, scoped
access, blocked Reading publication, retained jobs, and reminder resume without
repeat delivery. The Reading capture browser test also pauses and resumes from a
second client and verifies the current browser hides and restores Reading.

## Plugin navigation parity

After building the plugin, run
`node scripts/visual-test-run.mjs tests/visual/plugin-navigation.spec.ts tests/visual/plugin-navigation-webkit.spec.ts --workers=2`.
The Shadow DOM fixture covers the production plugin navigation shell at narrow and
wide widths, Today/Upcoming selection, project Back and retained scroll/focus,
Reading search and article return, keyboard/held dock expansion, disabled features,
rapid switching, reduced motion, and compact project sheets. Run `node scripts/pwa-dock-test.mjs` and
`node scripts/pwa-schedule-test.mjs` after rebuilding the Worker for the shared
components’ PWA adapters. Actual Obsidian panes, popout windows and mobile navbar
insets still require host/device acceptance.
## Encryption acceptance

`encryption-setup.integration.ts` exercises both empty and populated remotes through the production conversion client and local Worker bindings. It checks that setup leaves local files unsent, first sync uploads ciphertext, existing history survives conversion, pending edits wait for encrypted sync, and file counts advance only after verified acknowledgments. A lost response resumes with the remaining count. The setup browser harness covers the dedicated progress, retry and completion screens without server requests.

Folder-move coverage uses only disposable local storage. `encryption-folder-moves.integration.ts` checks retained credentials, Reading policy generation, push subscriptions and accepted/unaccepted Reading attempts; selecting a different configured folder must revoke the old connection. The native storage harness authenticates multiple offline moves, rejects substituted paths/access identities and preserves drafts through key recovery. The full Reminders and Reading browser scripts exercise the production apps after conversion and normal conditional file moves, retaining their original sessions without new links. Reading also follows a move in the already-open page. Reminder API regression tests preserve queued semantic revisions while encrypting replacements for the current path.

`node scripts/pwa-encryption-storage-test.mjs` exercises native Chromium/WebKit CryptoKey storage with the production session hook and a delayed cache-cleanup boundary. It covers cross-tab re-enrollment during logout, preservation of new drafts and immutable attempts after reload, rollback when authority changes during deletion, normal logout erasure, repair of partially damaged keys, and preservation of unsupported or unrecoverable records. The full encryption browser test also exercises damaged-key recovery through the unlock UI and conversion with absent or populated shared settings, including the first encrypted settings write.

The storage harness also queues real database opens behind blocked native deletions: bootstrap, key enrollment, attempt access and logout cleanup must reject promptly, push decryption must fall back, failed operations must preserve bytes, and abandoned opens must not create stores or write after unblocking. It checks successful retry and future-format preservation in both engines. Unit tests run the production service-worker push handler through the generic-notification deadline and fence late open/upgrade events. Worker `encrypted-settings.integration.ts` converts and updates settings at the former failure size and the full plaintext request limit, preserves committed settings after oversized writes, and verifies that preflight rejects unsupported stored settings before freezing sync. The full encryption browser test uses a 2,000-entry exclusion list for conversion and encrypted writes.

`node scripts/pwa-encryption-test.mjs` exercises both Chromium and WebKit against a disposable production self-hosted runtime. It covers active/locked/converting encryption status and native IndexedDB cleanup, including expired acknowledgments, pending references from older sessions, drafts, damaged/unknown entries, folder isolation, and stale-session fences. It belongs to `test:pwa-browser`. Recovery-verification and settings tests check that conversion is gated on decrypting the saved key and that editing the input or changing the connection invalidates verification. Worker `maintenance/encryption-metadata.integration.ts` checks bounded descriptor cleanup and references from files, history, receipts, changelog and upload leases. Run the encryption unit tests, Worker `encryption.integration.ts`, the full sync/notification regressions, and paired backup tests before enabling encryption in a release. Physical iOS/Android background push, browser storage eviction, hosted Worker limits and an independent security review remain separate acceptance checks; see [encryption](e2ee-implementation.md).

`CRATE_PWA_PREBUILT=1 node scripts/pwa-encryption-regressions-test.mjs` checks long reminder completion, large legacy receipt conversion, plaintext that resembles ciphertext, and interrupted conversion/save retries against the production local server in Chromium and WebKit. Run `npm run build:worker` first, or omit `CRATE_PWA_PREBUILT` to build automatically.

Worker `encrypted-source-rebuild.integration.ts` covers conversion of previously indexed folders, parser upgrades repairing missing/quarantined encrypted sources, notes exceeding the former 1 MiB source and 2 MiB reparse limits, and atomic chunked scheduling for 2,000 reminders with rollback and stable command tokens.

Worker `encrypted-sync-engine.integration.ts` runs the production sync engines against D1/R2/DO bindings with persistent mock vaults: three-device offline merges, deletion and cross-key-scope rename races, upload-response loss across restart, binary conflict preservation, and a 25 MiB attachment round trip. `encryption.integration.ts` also bounds cleanup queries across full conversion pages while preserving live files and retained history.

`encryption-upload-validation.integration.ts` exercises authenticated single and batch uploads against real D1/R2/DO bindings. It rejects plaintext, mixed batches and malformed encrypted framing before any staging lease or R2 write, verifies the content guard with an explicit encryption snapshot, and checks valid ciphertext receipt replay. Reset/upload regressions cover both the public transfer boundary and delayed publication inside the transfer executor.

After `npm run build:plugin`, run `node scripts/encryption-setup-test.mjs` for the
Obsidian encryption setup UI. It uses production key verification with a synthetic
Obsidian host in Chromium and WebKit, at desktop, phone and small-screen sizes in
both themes. It checks that loading and setup keep the same bounds and
header/footer positions, including reduced motion and touch-sized screens. It
also checks full recovery-key visibility, a compact field with Copy above it,
centered checkbox alignment, native settings-row spacing, keyboard acknowledgment, disabling the
action when unchecked, the visible footer, expanded details, clipboard success and
fallback, conversion progress, retry and connection changes without
contacting a server. Set `CRATE_OBSIDIAN_CSS_PATH` to an extracted installed
Obsidian `app.css` to repeat the checks with the actual host stylesheet; it is
used only locally and is not committed. The synthetic host also includes the
modal settings-row selector that previously overrode the key field’s spacing.
Physical Obsidian mobile and keyboard behavior still need
manual verification. Unit tests in `src/ui/settings/encryption-section.test.ts`
cover automatic key-verification failure before setup and recovery of missing,
damaged or incorrect local keys before resuming conversion. The optional saved-key
check retains wrong-key, edit and stale-result coverage.

### Reading encryption acceptance

- `reading-encryption.integration.ts` covers ciphertext-only capture/edit/replay, folder isolation, blocked plaintext paths, queued captures, converted receipts and adding a scope to an already encrypted vault after a lost conversion response.
- `encryption-reset.integration.ts` seeds all seven Reading tables and checks immediate/final deletion and old-grant rejection.
- `scripts/pwa-reading-encryption-test.mjs` runs the production PWA against disposable local bindings. Chromium covers offline edits/reload and exact ciphertext retry after response loss. Both browser engines cover enrollment, article access, logout key removal and a Shortcut arriving before folder unlock. It also checks that the production nonce-based CSP blocks injected inline and same-origin scripts while the app and deferred Reading code load, and that hostile encrypted article content remains inert after opening (and offline reopening in Chromium). Use `CRATE_TEST_BROWSER=webkit` for WebKit.
- `node scripts/reading-content-security-test.mjs` mounts the production reader and reminder card in Chromium/WebKit document and Shadow DOM hosts with CSP disabled. It covers hostile HTML, malformed mixed namespaces, event handlers, active URLs, DOM clobbering, code-highlighter output and resource requests, while preserving benign Markdown and code. It runs in `test:pwa-browser`. This is regression coverage, not a substitute for an independent security review.
- `scripts/pwa-reading-encryption-storage-test.mjs` covers atomic legacy migration/rollback, scope-key recovery, preserving unrelated sessions, locked reads and cleanup racing a new sign-in in both engines.
- `node scripts/pwa-web-app-unlock-test.mjs`: shared recovery-key unlock for Reading/Reminders in Chromium and WebKit, wrong-vault rejection, session changes during import, native key persistence and offline draft recovery after reimport/reload.
- Native iOS Shortcut signing/import and physical iOS/Android offline/push delivery remain manual acceptance. Test encrypted Android after reinstalling its changed manifest. Hosted quota validation must use an explicitly budgeted disposable deployment; do not run local test fixtures against hosted D1.

## Encrypted iPhone onboarding

`node scripts/pwa-encryption-onboarding-test.mjs` checks the production PWA against fixture HTTP responses in Chromium and WebKit: Safari installation guidance, isolated installed-app storage, Reading and Reminders first unlock, wrong-key feedback, pending controls, remembered keys after reload, recovery after key loss, desktop copy and a 320px viewport. These contexts model iOS storage separation; physical Add to Home Screen and background push still require device acceptance.

Mobile setup links first offer **Continue to web** and **Install Crate**. The
script verifies that installation instructions leave vault screens unmounted,
reload keeps the choice, continuing opens the browser app and remembers that
choice, iOS/Android guidance differs, and standalone launches skip the chooser.

The same script starts each destination with one app credential and verifies that
one unlock opens both sections. It simulates offline API failures while serving
app assets, restores an encrypted Reading draft after reload, and expires an
encrypted Reading data request to verify app-wide reconnect without deleting the
draft. `pwa-sync-coordinator-test.mjs` also covers independent background delivery,
feature failures and shared logout before delayed/failed remote revocation.

### Copy-free encrypted app approval

`node scripts/pwa-pairing-test.mjs` runs the production PWA and approval modal in
separate Chromium/WebKit contexts with real WebCrypto and native IndexedDB. The Obsidian DOM host and HTTP relay are fixtures; service workers are blocked
so requests stay in that fixture. The full encryption suites cover the real worker. It checks both feature entry
points, matching codes, no key persistence until both sides confirm (even after receiving a packet), no plaintext secrets in requests,
cancellation, expiry/restart, transient retry, both scopes, non-extractable stored
keys, reload and 320px light/dark layouts. It runs in `test:pwa-browser`.

Worker `encryption-pairing.integration.ts` checks the actual authenticated relay
with local D1, including Reading scope checks, concurrent claims, replay,
cancellation, expiry, revocation, conversion/reset fences and attempt limits.
`encryption/pairing/protocol.test.ts`, `plugin/web-app-pairing.test.ts`, and
`pwa/web-app-unlock.test.ts` cover cryptographic binding, vault/session guards,
limited grants and storage validation. These tests write no hosted D1 rows.

On a physical iPhone, install from Safari, open the Home Screen app, select
**Connect with Obsidian**, compare the codes in **Manage encryption → Connect web
app**, and approve. Select **Confirm and unlock** in the app after comparing its code. Verify both sections and relaunch. Repeat after backgrounding
either screen and after a network interruption. Desktop WebKit does not establish
native installation, storage-eviction or background-push acceptance.

The full Reading/Reminders encryption browser suites retain real service workers
and native storage. Their headless WebKit context disables the native push manager:
`getSubscription()` freezes the page on the current macOS test host, reproducible
on an empty page without Crate. Chromium keeps its native provider. These suites
do not establish physical-device push acceptance.
