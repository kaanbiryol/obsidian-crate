import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRATE_PLUGIN_PROTOCOL } from '../protocol';
import { createRuntimeHarness, setAcceptingEvents, setSyncEngine } from './runtime-test-harness';
import type { SyncState } from './types';

const serverInfo = { service: 'crate', serverVersion: 'dev', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: ['sync-v3'] };

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
		setSyncEngine(runtime, { getState: () => state, sync, initialSync: sync, forceFullSync: sync });
		setAcceptingEvents(runtime, true);
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
		setSyncEngine(runtime, { getState: () => state, sync, initialSync: sync, forceFullSync: sync });
		setAcceptingEvents(runtime, true);
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
		setSyncEngine(runtime, { getState: () => state, sync, initialSync: sync, forceFullSync: sync });
		setAcceptingEvents(runtime, true);
		vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
			options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
		})));
		runtime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(8_000);
		expect(runtime.getState().status).toBe('offline');
		expect(runtime.getState().lastError).toContain('too long to respond');
		expect(sync).not.toHaveBeenCalled();
	});
});
