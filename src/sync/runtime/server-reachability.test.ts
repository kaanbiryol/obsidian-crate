import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import { createDeferred, createRuntimeHarness, initializeRuntime } from './runtime-test-harness';
import type { SyncState } from '../types';

const serverInfo = { service: 'crate', serverVersion: 'dev', serverRevision: 4, reminderOperationDay: 20_000, protocol: CRATE_PLUGIN_PROTOCOL, capabilities: ['sync-v1'] };

describe('manual sync server status', () => {
	beforeEach(() => {
		vi.stubGlobal('window', globalThis);
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('shows an unavailable server before sync and clears it after a later check', async () => {
		const { runtime } = createRuntimeHarness({ automaticSync: false, workerUrl: 'https://old.trycloudflare.com' });
		const state: SyncState = { status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 };
		const sync = vi.fn();
		await initializeRuntime(runtime, { getState: () => state, sync, forceFullSync: sync });
		const listener = vi.fn();
		runtime.addStateChangeListener(listener);
		vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

		runtime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(2_000);
		expect(runtime.getState().status).toBe('offline');
		expect(runtime.getState().lastError).toContain('latest HTTPS address');
		expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'offline' }));
		expect(sync).not.toHaveBeenCalled();

		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(serverInfo))));
		await vi.advanceTimersByTimeAsync(60_000);
		runtime.triggerForegroundSync('online');
		await vi.advanceTimersByTimeAsync(2_000);
		expect(runtime.getState().status).toBe('idle');
		expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'idle', lastError: null }));
	});

	it('does not publish an obsolete probe after a newer sync succeeds', async () => {
		const { runtime } = createRuntimeHarness({ automaticSync: false });
		const state: SyncState = { status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 };
		const sync = vi.fn();
		await initializeRuntime(runtime, { getState: () => state, sync, forceFullSync: sync });
		let rejectRequest!: (error: Error) => void;
		vi.stubGlobal('fetch', vi.fn()
			.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectRequest = reject; }))
			.mockRejectedValueOnce(new TypeError('Failed to fetch')));
		runtime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(2_000);
		// The sync completes while an earlier connection check is still in flight.
		state.status = 'idle';
		state.lastSync = '2026-01-01T00:00:03.000Z';
		rejectRequest(new Error('network unavailable'));
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.getState().status).toBe('idle');
	});

	it('reports a bounded timeout without starting a sync', async () => {
		const { runtime } = createRuntimeHarness({ automaticSync: false });
		const state: SyncState = { status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 };
		const sync = vi.fn();
		await initializeRuntime(runtime, { getState: () => state, sync, forceFullSync: sync });
		vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
			options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
		})));
		runtime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(8_000);
		expect(runtime.getState().status).toBe('offline');
		expect(runtime.getState().lastError).toContain('too long to respond');
		expect(sync).not.toHaveBeenCalled();
	});

	it.each(['destroy', 'replace'] as const)('cancels a probe and ignores a delayed response when the runtime is %s', async action => {
		const { runtime } = createRuntimeHarness({ automaticSync: false });
		await initializeRuntime(runtime);
		const pending = createDeferred<Response>();
		const fetch = vi.fn((_url: string, _options: RequestInit) => pending.promise);
		vi.stubGlobal('fetch', fetch);
		await vi.advanceTimersByTimeAsync(2_000);
		const signal = fetch.mock.calls[0]![1].signal!;
		if (action === 'destroy') runtime.destroy();
		else await initializeRuntime(runtime);
		expect(signal.aborted).toBe(true);
		const listener = vi.fn();
		runtime.addStateChangeListener(listener);
		pending.resolve(new Response(null, { status: 503 }));
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.getState().status).toBe('idle');
		expect(listener).not.toHaveBeenCalled();
	});

	it('coalesces scheduled probes and respects the cooldown', async () => {
		const { runtime } = createRuntimeHarness({ automaticSync: false });
		await initializeRuntime(runtime);
		const fetch = vi.fn(async () => new Response(JSON.stringify(serverInfo)));
		vi.stubGlobal('fetch', fetch);
		runtime.triggerForegroundSync('focus');
		runtime.triggerForegroundSync('online');
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fetch).toHaveBeenCalledOnce();
		runtime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fetch).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(58_000);
		runtime.triggerForegroundSync('online');
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('shows server changes from a manual-mode check and clears them when a sync starts', async () => {
		const { runtime, engineHooks } = createRuntimeHarness({ automaticSync: false });
		const state: SyncState = { status: 'idle', lastSync: '2026-01-01T00:00:00.000Z', lastError: null, pendingChanges: 0, conflictCount: 0 };
		const sync = vi.fn();
		const hasRemoteChanges = vi.fn(async () => true);
		await initializeRuntime(runtime, { getState: () => state, sync, forceFullSync: sync, hasRemoteChanges });
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(serverInfo))));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(runtime.getState().remoteChanges).toBe(true);
		expect(sync).not.toHaveBeenCalled();

		// Found changes stay until a sync, so the next check skips the changelog.
		await vi.advanceTimersByTimeAsync(60_000);
		runtime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(2_000);
		expect(hasRemoteChanges).toHaveBeenCalledOnce();

		state.status = 'syncing';
		engineHooks().onStateChange?.(state);
		state.status = 'idle';
		expect(runtime.getState().remoteChanges).toBeUndefined();
	});

	it('checks for server changes on the manual interval without a foreground event', async () => {
		const { runtime, engineHooks } = createRuntimeHarness({ automaticSync: false });
		const state: SyncState = { status: 'idle', lastSync: '2026-01-01T00:00:00.000Z', lastError: null, pendingChanges: 0, conflictCount: 0 };
		const hasRemoteChanges = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		await initializeRuntime(runtime, { getState: () => state, hasRemoteChanges });
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(serverInfo))));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(runtime.getState().remoteChanges).toBeUndefined();

		await vi.advanceTimersByTimeAsync(60_000);
		engineHooks().onManualCheckDue?.();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(runtime.getState().remoteChanges).toBe(true);
	});

	it('skips the changes check while the server is unavailable', async () => {
		const { runtime } = createRuntimeHarness({ automaticSync: false });
		const state: SyncState = { status: 'idle', lastSync: '2026-01-01T00:00:00.000Z', lastError: null, pendingChanges: 0, conflictCount: 0 };
		const hasRemoteChanges = vi.fn(async () => true);
		await initializeRuntime(runtime, { getState: () => state, hasRemoteChanges });
		vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(runtime.getState()).toMatchObject({ status: 'offline' });
		expect(hasRemoteChanges).not.toHaveBeenCalled();
	});

	it('does not publish server changes found by a check that a sync overtook', async () => {
		const { runtime } = createRuntimeHarness({ automaticSync: false });
		const state: SyncState = { status: 'idle', lastSync: '2026-01-01T00:00:00.000Z', lastError: null, pendingChanges: 0, conflictCount: 0 };
		const pending = createDeferred<boolean>();
		await initializeRuntime(runtime, { getState: () => state, hasRemoteChanges: () => pending.promise });
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(serverInfo))));
		await vi.advanceTimersByTimeAsync(2_000);
		state.lastSync = '2026-01-01T00:00:03.000Z';
		pending.resolve(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.getState().remoteChanges).toBeUndefined();
	});

	it('runs a check on every tick of a one-minute interval', async () => {
		const { runtime, engineHooks } = createRuntimeHarness({ automaticSync: false });
		await initializeRuntime(runtime, { hasRemoteChanges: vi.fn(async () => false) });
		const fetch = vi.fn(async () => new Response(JSON.stringify(serverInfo)));
		vi.stubGlobal('fetch', fetch);
		await vi.advanceTimersByTimeAsync(2_000);
		for (let tick = 0; tick < 3; tick++) {
			await vi.advanceTimersByTimeAsync(58_000);
			engineHooks().onManualCheckDue?.();
			await vi.advanceTimersByTimeAsync(2_000);
		}
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it('does not start the cooldown for a check that a running sync skipped', async () => {
		const { runtime } = createRuntimeHarness({ automaticSync: false });
		const state: SyncState = { status: 'syncing', lastSync: '2026-01-01T00:00:00.000Z', lastError: null, pendingChanges: 0, conflictCount: 0 };
		await initializeRuntime(runtime, { getState: () => state, hasRemoteChanges: vi.fn(async () => false) });
		const fetch = vi.fn(async () => new Response(JSON.stringify(serverInfo)));
		vi.stubGlobal('fetch', fetch);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fetch).not.toHaveBeenCalled();

		state.status = 'idle';
		runtime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fetch).toHaveBeenCalledOnce();
	});
});
