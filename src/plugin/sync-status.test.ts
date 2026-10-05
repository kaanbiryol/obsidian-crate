import { beforeEach, expect, it, vi } from 'vitest';
import { SyncEngine } from '../sync/engine';
import { createDeferred, createRuntimeHarness, initializeRuntime } from '../sync/runtime-test-harness';
import { createEmptySyncResult } from '../sync/sync-result';
import { registerSyncStatus } from './sync-status';

const { status, constructed } = vi.hoisted(() => ({
  constructed: vi.fn(),
  status: { setEnabled: vi.fn(), update: vi.fn(), setSyncProgress: vi.fn(), clearSyncProgress: vi.fn(), destroy: vi.fn() },
}));
vi.mock('../ui/status', () => ({ StatusBarManager: class {
  constructor(...args: unknown[]) { constructed(...args); return status; }
} }));
beforeEach(() => { vi.clearAllMocks(); });

function mountStatus() {
  const harness = createRuntimeHarness();
  const register = vi.fn<(cleanup: () => void) => void>();
  const onClick = vi.fn();
  registerSyncStatus({ ...harness.plugin, register } as never, harness.runtime, onClick);
  return { ...harness, dispose: () => register.mock.calls[0]![0](), onClick };
}

it('follows initialization, stop and restart, and unsubscribes on plugin unload', async () => {
  const { runtime, dispose, onClick } = mountStatus();
  expect(status.setEnabled).toHaveBeenLastCalledWith(false);
  expect(constructed).toHaveBeenCalledWith(expect.anything(), false, onClick);
  await initializeRuntime(runtime);
  expect(status.setEnabled).toHaveBeenLastCalledWith(true);
  runtime.destroy();
  expect(status.setEnabled).toHaveBeenLastCalledWith(false);
  await initializeRuntime(runtime);
  expect(status.setEnabled).toHaveBeenLastCalledWith(true);
  dispose();
  expect(status.destroy).toHaveBeenCalledOnce();
  status.update.mockClear();
  runtime.destroy();
  await initializeRuntime(runtime);
  expect(status.update).not.toHaveBeenCalled();
});

it('keeps an initialization failure visible until the runtime stops', async () => {
  const { runtime } = mountStatus();
  const initialize = vi.spyOn(SyncEngine.prototype, 'initialize').mockRejectedValueOnce(new Error('Manifest unavailable'));
  try {
    await expect(runtime.initialize()).rejects.toThrow('Manifest unavailable');
    expect(runtime.isInitialized()).toBe(false);
    expect(status.setEnabled).toHaveBeenLastCalledWith(true);
    expect(status.update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', lastError: 'Manifest unavailable' }));
    runtime.destroy();
    expect(status.setEnabled).toHaveBeenLastCalledWith(false);
  } finally { initialize.mockRestore(); }
});

it('shows transfer and saving progress until persistence finishes, then restores idle status', async () => {
  const { runtime, persistSettings } = mountStatus();
  const saved = createDeferred<void>();
  await initializeRuntime(runtime, { sync: async progress => {
    progress?.(2, 3);
    return createEmptySyncResult();
  } });
  persistSettings.mockReturnValue(saved.promise);
  const syncing = runtime.sync();
  expect(status.setSyncProgress).toHaveBeenCalledWith(2, 3);
  await vi.waitFor(() => expect(persistSettings).toHaveBeenCalledOnce());
  expect(status.update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'syncing', work: { phase: 'saving' } }));
  saved.resolve();
  await syncing;
  expect(status.update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'idle' }));
});
