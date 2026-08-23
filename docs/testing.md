# Testing

## Framework and Config

- **Framework:** vitest
- **Config:** `vitest.config.ts`
- **Test pattern:** `src/**/*.test.ts` (co-located next to source)
- **Path aliases:** `src` -> `src/`, `obsidian` -> `src/test/mocks/obsidian.ts`

```bash
npm test                                  # run all tests
npx vitest run src/sync/planner.test.ts   # single test file
```

## Release verification

Run the release gate before publishing either deliverable:

```bash
npm run release:check
```

It builds and checks both TypeScript targets, runs lint and the complete test suite, creates production plugin and Worker artifacts, enforces raw/gzip size budgets, validates manifest/version consistency and required Wrangler bindings, and checks for the OAuth deployment entry point.

The individual size gates are also available as `npm run size-check:plugin` and `npm run size-check:worker`. A Cloudflare configuration change should additionally pass:

```bash
npx --yes wrangler@4.123.0 deploy --dry-run
```

## Manual Obsidian Smoke Test

Run this before merging changes that touch sync orchestration, reminder parsing, markdown scanning, shadow DOM rendering, or reminder view styles:

- Start `npm run dev`. Successful builds are copied to `test-vault/.obsidian/plugins/crate/` automatically.
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
6. Confirm Crate creates one `crate-<16 hex>` Worker, D1 database, and R2 bucket, applies the migration, enables the workers.dev endpoint, and connects the current device.
7. Select **Disconnect this device**, connect with Cloudflare again, and confirm Crate reuses the same Worker instead of creating another deployment.
8. Exercise initial sync with non-critical notes only.
9. Select **Authorize update** and confirm the same Worker, D1 database, R2 bucket, and Durable Object namespaces are reused.
10. For the inactive-R2 case, use an account without an active R2 subscription and confirm Crate shows the activation message rather than a generic API error.

The test creates real resources only when a person completes Cloudflare consent. Delete disposable resources manually from that test account after validation. Never paste OAuth codes, access tokens, or PKCE values into issue reports or test logs.

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

### Module-Level Harness (transfer.test.ts)

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

### Module Mocking with vi.hoisted() (planner.test.ts, transfer.test.ts)

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
