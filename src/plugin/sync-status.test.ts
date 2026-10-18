import { beforeEach, expect, it, vi } from 'vitest';
import { SyncEngine } from '../sync/engine';
import { createDeferred, createRuntimeHarness, initializeRuntime } from '../sync/runtime-test-harness';
import { createEmptySyncResult } from '../sync/sync-result';
import type { SyncState } from '../sync/types';
import { registerSyncStatus } from './sync-status';

const { status, constructed } = vi.hoisted(() => ({
  constructed: vi.fn(),
  status: { setEnabled: vi.fn(), update: vi.fn<(state: SyncState) => void>(), setSyncProgress: vi.fn(), clearSyncProgress: vi.fn(), destroy: vi.fn() },
}));
vi.mock('../ui/status', () => ({ StatusBarManager: class {
  constructor(...args: unknown[]) { constructed(...args); return status; }
} }));
beforeEach(() => { vi.clearAllMocks(); });

function mountStatus(settings: Parameters<typeof createRuntimeHarness>[0] = {}) {
  const harness = createRuntimeHarness(settings);
  const register = vi.fn<(cleanup: () => void) => void>();
  const onClick = vi.fn();
  registerSyncStatus({ ...harness.plugin, register } as never, harness.runtime, onClick);
  return { ...harness, dispose: () => register.mock.calls[0]![0](), onClick };
}

it('follows initialization, stop and restart, and unsubscribes on plugin unload', async () => {
  const { runtime, dispose, onClick } = mountStatus();
  expect(status.setEnabled).toHaveBeenLastCalledWith(true);
  expect(status.update).toHaveBeenLastCalledWith(expect.objectContaining({ initializing: true }));
  expect(constructed).toHaveBeenCalledWith(expect.anything(), false, onClick);
  await initializeRuntime(runtime);
  expect(status.setEnabled).toHaveBeenLastCalledWith(true);
  runtime.destroy();
  await vi.waitFor(() => expect(status.setEnabled).toHaveBeenLastCalledWith(false));
  await initializeRuntime(runtime);
  expect(status.setEnabled).toHaveBeenLastCalledWith(true);
  dispose();
  expect(status.destroy).toHaveBeenCalledOnce();
  status.update.mockClear();
  runtime.destroy();
  await initializeRuntime(runtime);
  expect(status.update).not.toHaveBeenCalled();
});

it('keeps a configured vault in startup status while saved sync state loads', async () => {
  const { runtime } = mountStatus({ automaticSync: false, lastSync: '2026-10-01T00:00:00Z' });
  const loaded = createDeferred<void>();
  const initialize = vi.spyOn(SyncEngine.prototype, 'initialize').mockReturnValueOnce(loaded.promise);
  try {
    const starting = runtime.initialize();
    await vi.waitFor(() => expect(runtime.isInitialized()).toBe(true));
    expect(status.setEnabled).toHaveBeenLastCalledWith(true);
    expect(status.update.mock.calls.every(([state]) => state.initializing)).toBe(true);
    loaded.resolve();
    await starting;
    expect(status.update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'idle', lastSync: '2026-10-01T00:00:00Z' }));
    expect(runtime.getState().initializing).toBeFalsy();
  } finally { loaded.resolve(); initialize.mockRestore(); }
});

it('does not show an indefinite startup indicator for an unconfigured vault', () => {
  const { runtime } = mountStatus({ workerUrl: '' });
  expect(runtime.getState().initializing).toBeFalsy();
  expect(status.setEnabled).toHaveBeenLastCalledWith(false);
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
    await vi.waitFor(() => expect(status.setEnabled).toHaveBeenLastCalledWith(false));
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
  await vi.waitFor(() => expect(status.setSyncProgress).toHaveBeenCalledWith(2, 3));
  await vi.waitFor(() => expect(persistSettings).toHaveBeenCalledOnce());
  expect(status.update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'syncing', work: { phase: 'saving' } }));
  saved.resolve();
  await syncing;
  expect(status.update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'idle' }));
});

it('renders a burst of state and progress events once', async () => {
  const { runtime } = mountStatus();
  await initializeRuntime(runtime);
  await Promise.resolve();
  status.update.mockClear();
  const listeners = { state: [] as Array<() => void>, progress: [] as Array<() => void> };
  const register = vi.fn<(cleanup: () => void) => void>();
  registerSyncStatus({ register } as never, {
    isInitialized: () => true, getState: () => runtime.getState(), getActivityProgress: () => null,
    addStateChangeListener: listener => listeners.state.push(listener as () => void),
    addProgressListener: listener => listeners.progress.push(listener as () => void),
    removeStateChangeListener: vi.fn(), removeProgressListener: vi.fn(),
  }, vi.fn());
  status.update.mockClear();
  // Before: one render per event, four per synced file.
  for (let event = 0; event < 4; event++) [...listeners.state, ...listeners.progress].forEach(listener => listener());
  await Promise.resolve();
  expect(status.update).toHaveBeenCalledOnce();
});
