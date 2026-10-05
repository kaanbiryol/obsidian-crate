import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOREGROUND_SYNC_COOLDOWN_MS, FOREGROUND_SYNC_DEBOUNCE_MS } from './runtime';
import { createEmptySyncResult } from './sync-result';
import { createRuntimeHarness, initializeRuntime } from './runtime-test-harness';

describe('SyncRuntime foreground sync', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('debounces foreground triggers and runs a sync', async () => {
		const { runtime, persistSettings } = createRuntimeHarness();
		const sync = vi.fn(async () => createEmptySyncResult());

		await initializeRuntime(runtime, {
			getState: () => ({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 }),
			sync,
			initialSync: vi.fn(async () => createEmptySyncResult()),
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		});

		runtime.triggerForegroundSync('focus');
		runtime.triggerForegroundSync('visible');

		expect(sync).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);

		expect(sync).toHaveBeenCalledTimes(1);
		expect(persistSettings).toHaveBeenCalledTimes(1);
	});

	it('throttles repeated foreground syncs with a cooldown', async () => {
		const { runtime } = createRuntimeHarness();
		const sync = vi.fn(async () => createEmptySyncResult());

		await initializeRuntime(runtime, {
			getState: () => ({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 }),
			sync,
			initialSync: vi.fn(async () => createEmptySyncResult()),
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		});

		runtime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(sync).toHaveBeenCalledTimes(1);

		runtime.triggerForegroundSync('visible');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(sync).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_COOLDOWN_MS);
		runtime.triggerForegroundSync('online');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(sync).toHaveBeenCalledTimes(2);
	});

	it('does not foreground sync before initialization or when automatic sync is disabled', async () => {
		const { runtime: pausedRuntime } = createRuntimeHarness();
		const pausedSync = vi.spyOn(pausedRuntime, 'sync');


		pausedRuntime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(pausedSync).not.toHaveBeenCalled();

		const { runtime: disabledRuntime } = createRuntimeHarness({ automaticSync: false });
		const disabledSync = vi.fn(async () => createEmptySyncResult());
		await initializeRuntime(disabledRuntime, {
			getState: () => ({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 }),
			sync: disabledSync,
			initialSync: vi.fn(async () => createEmptySyncResult()),
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		});

		disabledRuntime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(disabledSync).not.toHaveBeenCalled();
	});
});
