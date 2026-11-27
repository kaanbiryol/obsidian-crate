import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptySyncResult } from '../sync-result';
import { createRuntimeHarness, initializeRuntime } from './runtime-test-harness';
import { FOREGROUND_SYNC_COOLDOWN_MS, FOREGROUND_SYNC_DEBOUNCE_MS } from './foreground-sync';

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
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
			foregroundSyncNeeded: vi.fn(async () => true),
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
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
			foregroundSyncNeeded: vi.fn(async () => true),
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
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		});

		disabledRuntime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(disabledSync).not.toHaveBeenCalled();
	});

	it('skips the sync when the check finds nothing, and walks the vault only without background file events', async () => {
		for (const fileEventsInBackground of [true, false]) {
			const { runtime } = createRuntimeHarness({ syncInterval: 300 }, undefined, { fileEventsInBackground });
			const sync = vi.fn(async () => createEmptySyncResult());
			const foregroundSyncNeeded = vi.fn(async () => false);
			await initializeRuntime(runtime, {
				getState: () => ({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 }),
				sync, foregroundSyncNeeded,
			});

			runtime.triggerForegroundSync('focus');
			await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
			expect(foregroundSyncNeeded).toHaveBeenCalledWith(!fileEventsInBackground);
			expect(sync).not.toHaveBeenCalled();
		}
	});

	it('still syncs when the check fails, so the sync reports the failure', async () => {
		const { runtime } = createRuntimeHarness();
		const sync = vi.fn(async () => createEmptySyncResult());
		await initializeRuntime(runtime, {
			getState: () => ({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 }),
			sync, foregroundSyncNeeded: vi.fn(async () => { throw new Error('Failed to fetch'); }),
		});

		runtime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(sync).toHaveBeenCalledOnce();
	});

	it('walks on desktop when no periodic check walks instead', async () => {
		const { runtime } = createRuntimeHarness({ syncInterval: 0 }, undefined, { fileEventsInBackground: true });
		const foregroundSyncNeeded = vi.fn(async () => false);
		await initializeRuntime(runtime, {
			getState: () => ({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 }),
			sync: vi.fn(async () => createEmptySyncResult()), foregroundSyncNeeded,
		});

		runtime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(foregroundSyncNeeded).toHaveBeenCalledWith(true);
	});

	it('syncs without a check when an earlier sync left an error, so the sync can clear it', async () => {
		const { runtime } = createRuntimeHarness({}, undefined, { fileEventsInBackground: true });
		const sync = vi.fn(async () => createEmptySyncResult());
		const foregroundSyncNeeded = vi.fn(async () => false);
		await initializeRuntime(runtime, {
			getState: () => ({ status: 'error', lastSync: null, lastError: 'Sync failed', pendingChanges: 0, conflictCount: 0 }),
			sync, foregroundSyncNeeded,
		});

		runtime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(foregroundSyncNeeded).not.toHaveBeenCalled();
		expect(sync).toHaveBeenCalledOnce();
	});
});

