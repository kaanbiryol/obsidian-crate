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

Sync modules define narrow context interfaces (e.g., `TransferContext`, `PlannerManifest`, `QueueFlushContext`) rather than depending on concrete classes. This makes tests easy to write with partial mocks:

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
