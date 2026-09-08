# Testing

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

`sync-engine.integration.ts` runs separate real sync engines through the authenticated Worker API. Each simulated device retains its own files, settings and disk checkpoints across restarts. It checks three-device offline merging, edit/delete ordering, rename/edit races, interrupted uploads after the server commits, binary conflict preservation, and filenames such as `__proto__`. Only the Obsidian filesystem/UI surface is simulated; planning, transfer, HTTP serialization, authentication, D1 and R2 use production code.

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

### Browser list capacity

`npm run benchmark:pwa` measures the production PWA with a local synthetic API in Chromium and WebKit at a 390 × 844 viewport. It is also included in `test:pwa-browser`. The test checks page navigation, off-page editing, saved changes, complete reorder payloads and bounded rendered rows at 1,000 and 10,000 reminders. The fixture deliberately stresses a single Inbox; it does not claim that 10,000 reminders fit the real per-file indexing limits.

The PWA now pages active, completed and date-grouped lists in batches of 200. A native page selector reaches any range. Paging affects rendered rows only: counts, cache, edits and reorder validation retain the full data. Obsidian's plugin views keep their existing behavior.

| Local 10,000-reminder Inbox | Before paging | With paging |
| --- | ---: | ---: |
| Chromium: first usable list | 7.24 s | 0.227 s |
| WebKit: first usable list | 23.07 s | 0.282 s |
| Mounted cards | 10,000 | 200 |
| DOM elements | 160,114 | 3,372 |

These are unthrottled local samples from September 7, 2026, with service workers disabled, not physical-device or network guarantees. The server still returns the full folder response. Reordering now accepts up to 10,000 IDs while retaining the 1 MiB request limit, stale-order checks and idempotent receipts; a real D1/R2 regression verifies reordering inside a 1,000-reminder project without changing other rows.

## Release verification

Run the release gate before publishing either deliverable:

```bash
npm run release:check
```

It first runs the npm advisory audit (including development dependencies, failing at low severity) and a checksum-pinned Gitleaks scan of complete fetched Git history and current source. Network failures and shallow clones fail this gate. It builds and checks both TypeScript targets, runs lint, dead-code analysis of both the full project and production dependency graph, the complete unit and Worker-runtime suites, and the PWA preview smoke test. It then creates production plugin and Worker artifacts, enforces raw/gzip size budgets, validates manifest/version consistency and required Wrangler bindings, and checks for the OAuth deployment entry point. Chromium/WebKit tests cover PWA storage, recovery, authentication, updates, concurrency, clock boundaries and capacity.

Asset limits are defined once in `scripts/bundle-budgets.mjs`; the artifact checks and PWA smoke test use the same byte limits. Tagged builds attach verified assets to a draft GitHub release. Publish the draft only after completing the physical-device and hosted acceptance record below.

The individual size gates are also available as `npm run size-check:plugin` and `npm run size-check:worker`. A Cloudflare configuration change should additionally pass:

```bash
npx --yes wrangler@4.123.0 deploy --dry-run
```

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
from a working vault. Fixed dates exercise overdue reminders; relative dates
exercise Today and Upcoming. The nested projects, recurrence, descriptions,
completed reminders, and sync walkthroughs provide the other demo scenarios.

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
4. Confirm the consent screen shows the expected verified publisher and exactly Workers Scripts Write, D1 Write, Workers R2 Storage Write, and Memberships Read. Cloudflare may display the three write permissions using its legacy **Edit** label. Select exactly one account.
5. Confirm the browser lands at `/oauth/callback/`, its address bar no longer contains OAuth parameters, and Obsidian opens. If automatic launch is blocked, select **Open Obsidian**.
6. Confirm Crate creates one `crate-<16 hex>` Worker, D1 database, and R2 bucket, initializes the schema, enables the workers.dev endpoint, and connects the current device.
7. Confirm connecting alone does not upload or download vault files. For a new server, explicitly select **Initial sync → Upload all** using non-critical notes only.
8. Select **Disconnect this device**, connect with Cloudflare again, and confirm Crate reuses the same Worker instead of creating another deployment.
9. Select **Authorize update** and confirm the same Worker, D1 database, R2 bucket, and Durable Object namespaces are reused.
10. For the inactive-R2 case, use an account without an active R2 subscription and confirm Crate shows the activation message rather than a generic API error.

The test creates real resources only when a person completes Cloudflare consent. Delete disposable resources manually from that test account after validation. Never paste OAuth codes, access tokens, or PKCE values into issue reports or test logs.

## Public-release acceptance

Copy [the release acceptance template](release-checklist.md) for each candidate and record the exact artifact checksums and results. Do not publish while any required item is incomplete.

Record the Obsidian version, operating-system version, and result for each device. Complete this matrix against the exact release assets before publishing:

- Run at least one pass on Obsidian 1.13.0, the version declared in `manifest.json`. If it is unavailable or any required flow fails, raise `minAppVersion` and the matching `versions.json` entry to the oldest version actually tested.
- Use a Cloudflare account that is not owned by or a member of the OAuth-client publisher. Confirm the verified publisher and exactly Workers Scripts Write, D1 Write, Workers R2 Storage Write, and Memberships Read.
- Install `main.js`, `manifest.json`, and `styles.css` from the prepared release assets into a clean desktop vault. Complete OAuth, explicit initial upload, restart, reconnect, and server update.
- On a physical iOS device, join the existing server with **Sync now**. Create, edit, rename, and delete Markdown and binary files; preserve a concurrent-edit conflict; background and resume Obsidian; then disable and re-enable Crate.
- Repeat the same existing-server flow on a physical Android device.
- On both mobile platforms, create, edit, complete, reorder, and delete reminders. Install the reminders web app, enable push, receive both a test notification and a scheduled reminder, verify sign-out, and confirm a signed-out browser cannot use the previous session.
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
