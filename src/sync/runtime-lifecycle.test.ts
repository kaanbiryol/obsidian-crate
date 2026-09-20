import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-dom/client', () => ({
	createRoot: () => ({ render: vi.fn(), unmount: vi.fn() }),
}));
import { SyncEngine } from './engine';
import { SyncApiClient } from './api';
import { SyncQueueController } from './queue-controller';
import { createEmptySyncResult } from './sync-result';
import type { SyncResult } from './types';
import {
	createDeferred,
	createRuntimeHarness,
	flushMicrotasks,
	isAcceptingEvents,
	setApiClient,
	type Deferred,
} from './runtime-test-harness';

describe('SyncRuntime teardown and reinitialization', () => {
	it('rejects a stale address update before stopping or changing a newer connection', async () => {
		const { runtime, settings, persistSettings } = createRuntimeHarness({ lastSeq: 42 });
		const destroy = vi.spyOn(runtime, 'destroy');
		await expect(runtime.applyInfrastructureConfig({ workerUrl: 'https://next.trycloudflare.com', authToken: 'token' }, undefined,
			{ workerUrl: 'https://obsolete.trycloudflare.com', authToken: 'token' })).rejects.toThrow('connection changed');
		expect(settings.workerUrl).toBe('https://worker.example');
		expect(settings.lastSeq).toBe(42);
		expect(destroy).not.toHaveBeenCalled();
		expect(persistSettings).not.toHaveBeenCalled();
	});
	let startupSyncs: Deferred<SyncResult>[];
	let queuedStartupSyncs: Deferred<SyncResult>[];

	beforeEach(() => {
		startupSyncs = [createDeferred<SyncResult>(), createDeferred<SyncResult>()];
		queuedStartupSyncs = [...startupSyncs];

		vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue(undefined);
		vi.spyOn(SyncEngine.prototype, 'sync').mockImplementation(async () => {
			const nextSync = queuedStartupSyncs.shift();
			return nextSync ? nextSync.promise : createEmptySyncResult();
		});
		vi.spyOn(SyncQueueController.prototype as unknown as { debouncedSync(): void }, 'debouncedSync').mockImplementation(() => {});
	});

	afterEach(async () => {
		for (const startupSync of startupSyncs) {
			startupSync.resolve(createEmptySyncResult());
		}
		await flushMicrotasks();
		vi.restoreAllMocks();
	});

	it('keeps events paused until the latest startup sync finishes after reinitialize', async () => {
		const { runtime } = createRuntimeHarness();
		const destroy = vi.spyOn(SyncEngine.prototype, 'destroy');

		await runtime.initialize();
		await runtime.initialize();

		expect(destroy).toHaveBeenCalledTimes(1);
		expect(isAcceptingEvents(runtime)).toBe(false);

		startupSyncs[0]?.resolve(createEmptySyncResult());
		await flushMicrotasks();

		expect(isAcceptingEvents(runtime)).toBe(false);

		runtime.onFileChange({ path: 'notes/still-blocked.md' } as never);
		expect(runtime.getPendingPaths()).toEqual([]);

		startupSyncs[1]?.resolve(createEmptySyncResult());
		await vi.waitFor(() => {
			expect(isAcceptingEvents(runtime)).toBe(true);
		});

		runtime.onFileChange({ path: 'notes/active.md' } as never);
		expect(runtime.getPendingPaths()).toEqual(['notes/active.md']);
	});

	it('does not re-enable events after destroy while startup sync is in flight', async () => {
		const { runtime } = createRuntimeHarness();

		await runtime.initialize();
		runtime.destroy();

		expect(isAcceptingEvents(runtime)).toBe(false);

		startupSyncs[0]?.resolve(createEmptySyncResult());
		await flushMicrotasks();

		expect(isAcceptingEvents(runtime)).toBe(false);
		runtime.onFileChange({ path: 'notes/after-destroy.md' } as never);
		expect(runtime.getPendingPaths()).toEqual([]);
	});

	it('stops immediately, drains old work, and leaves manual sync available without restarting automatic sync', async () => {
		const { runtime, settings, secretStorage, persistSettings } = createRuntimeHarness({ lastSeq: 42 });
		const signals = vi.spyOn(SyncApiClient.prototype, 'setAbortSignal');
		const drained = createDeferred<void>();
		const waitForIdle = vi.spyOn(SyncEngine.prototype, 'waitForIdle').mockReturnValueOnce(drained.promise);
		const initialize = vi.spyOn(SyncEngine.prototype, 'initialize');
		await runtime.initialize();
		const oldSignal = signals.mock.calls[0]![0];
		const stopping = runtime.stopSync();
		expect(runtime.stopSync()).toBe(stopping);
		expect(oldSignal.aborted).toBe(true);
		expect(settings.automaticSync).toBe(false);
		expect(isAcceptingEvents(runtime)).toBe(false);
		await flushMicrotasks();
		expect(initialize).toHaveBeenCalledTimes(1);
		expect(persistSettings).not.toHaveBeenCalled();
		await expect(runtime.sync()).resolves.toMatchObject({ success: false });
		startupSyncs[0]!.resolve(createEmptySyncResult());
		drained.resolve();
		await stopping;
		expect(waitForIdle).toHaveBeenCalled();
		expect(initialize).toHaveBeenCalledTimes(2);
		expect(vi.spyOn(SyncEngine.prototype, 'sync')).toHaveBeenCalledTimes(1);
		expect(persistSettings).toHaveBeenCalledOnce();
		expect(persistSettings).toHaveBeenCalledWith({ automaticSync: false });
		expect(settings.lastSeq).toBe(42);
		expect(settings.workerUrl).toBe('https://worker.example');
		expect(secretStorage.delete).not.toHaveBeenCalled();
		expect(runtime.isConfigured()).toBe(true);
		expect(isAcceptingEvents(runtime)).toBe(true);
		runtime.triggerForegroundSync('focus');
		expect(vi.spyOn(SyncEngine.prototype, 'sync')).toHaveBeenCalledTimes(1);
		vi.spyOn(SyncEngine.prototype, 'sync').mockResolvedValue(createEmptySyncResult());
		await expect(runtime.sync()).resolves.toMatchObject({ success: true });
		expect(settings.automaticSync).toBe(false);
		runtime.destroy();
	});

	it('does not restart after unloading while stop sync is saving settings', async () => {
		const { runtime, persistSettings } = createRuntimeHarness({ automaticSync: false });
		await runtime.initialize();
		const saved = createDeferred<void>();
		persistSettings.mockReturnValueOnce(saved.promise);
		const stopping = runtime.stopSync();
		const rejected = expect(stopping).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(persistSettings).toHaveBeenCalledOnce());
		runtime.destroy();
		saved.resolve();
		await rejected;
		expect(vi.spyOn(SyncEngine.prototype, 'initialize')).toHaveBeenCalledTimes(1);
		expect(isAcceptingEvents(runtime)).toBe(false);
	});

	it('keeps the engine stopped when saving the automatic sync preference fails', async () => {
		const { runtime, persistSettings, settings } = createRuntimeHarness();
		await runtime.initialize();
		persistSettings.mockRejectedValueOnce(new Error('Disk full'));
		await expect(runtime.stopSync()).rejects.toThrow('Disk full');
		expect(settings.automaticSync).toBe(false);
		expect(runtime.getApiClient()).toBeNull();
		expect(vi.spyOn(SyncEngine.prototype, 'initialize')).toHaveBeenCalledTimes(1);
		runtime.destroy();
	});

	it('does not reinitialize infrastructure after unloading during a settings save', async () => {
		const { runtime, persistSettings } = createRuntimeHarness();
		const saved = createDeferred<void>();
		const lifetime = new AbortController();
		persistSettings.mockReturnValue(saved.promise);
		const initialize = vi.spyOn(runtime, 'initialize');
		const running = runtime.applyInfrastructureConfig({ workerUrl: 'https://crate.example.workers.dev', authToken: 'new-token' }, lifetime.signal);
		const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(persistSettings).toHaveBeenCalledOnce());
		lifetime.abort();
		runtime.destroy();
		saved.resolve();
		await rejected;
		expect(initialize).not.toHaveBeenCalled();
		expect(isAcceptingEvents(runtime)).toBe(false);
	});

	it('does not clear configuration after unloading while token revocation is pending', async () => {
		const { runtime, persistSettings, settings, secretStorage } = createRuntimeHarness();
		const revoked = createDeferred<{ success: boolean }>();
		const lifetime = new AbortController();
		setApiClient(runtime, {
			revokeCurrentToken: () => revoked.promise,
			testConnection: async () => ({ success: true }),
			putSharedSettings: async () => {},
		});
		const running = runtime.clearSyncConfiguration(lifetime.signal);
		const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
		lifetime.abort();
		runtime.destroy();
		revoked.resolve({ success: true });
		await rejected;
		expect(secretStorage.delete).not.toHaveBeenCalled();
		expect(settings.workerUrl).toBe('https://worker.example');
		expect(persistSettings).not.toHaveBeenCalled();
	});
});
