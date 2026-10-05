import { SyncEngine } from './engine';
import { describe, expect, it, vi } from 'vitest';
import { MAX_SYNC_HISTORY, MAX_SYNC_HISTORY_PATHS } from '../plugin/settings-types';
import type { SyncResult } from './types';
import { createEmptySyncResult } from './sync-result';
import { normalizeCrateSettings } from '../plugin/settings';
import { SyncRuntime } from './runtime';
import { formatSyncProgress } from '../ui/activity/progress-label';
import {
	createDeferred,
	createRuntimeHarness,
	mockApiClient,
	initializeRuntime,
} from './runtime-test-harness';

describe('SyncRuntime operation wrappers', () => {
	it.each(['manual', 'automatic'] as const)('does not publish %s completion after its engine is replaced during checkpointing', async mode => {
		const { runtime, persistSettings, settings } = createRuntimeHarness();
		const checkpoint = createDeferred<undefined>();
		const saveSharedHistoryCheckpoint = vi.fn(() => checkpoint.promise);
		const oldLocalCheckpoint = vi.fn(async () => 'old-checkpoint');
		const callback = vi.spyOn(SyncEngine.prototype, 'setAutomaticSyncResultCallback');
		await initializeRuntime(runtime, {
			sync: vi.fn(async () => createEmptySyncResult()),
			saveSharedHistoryCheckpoint, saveHistoryCheckpoint: oldLocalCheckpoint,
		});
		const automatic = callback.mock.calls.at(-1)![0];
		callback.mockRestore();
		const operation = mode === 'manual' ? runtime.sync() : automatic(createEmptySyncResult());
		await vi.waitFor(() => expect(saveSharedHistoryCheckpoint).toHaveBeenCalledOnce());
		const newLocalCheckpoint = vi.fn(async () => 'new-checkpoint');
		await initializeRuntime(runtime, { saveHistoryCheckpoint: newLocalCheckpoint });
		const entry = settings.syncHistory[0]!;
		const stateChanged = vi.fn();
		runtime.addStateChangeListener(stateChanged);
		checkpoint.resolve(undefined);
		await operation;
		expect(oldLocalCheckpoint).not.toHaveBeenCalled();
		expect(newLocalCheckpoint).not.toHaveBeenCalled();
		expect(entry).not.toHaveProperty('historyCheckpoint');
		expect(entry).not.toHaveProperty('sharedCheckpoint');
		expect(persistSettings).not.toHaveBeenCalled();
		expect(stateChanged).not.toHaveBeenCalled();
	});

	it('does not attach a local checkpoint or persist after destruction during its save', async () => {
		const { runtime, persistSettings, settings } = createRuntimeHarness();
		const checkpoint = createDeferred<string>();
		const saveHistoryCheckpoint = vi.fn(() => checkpoint.promise);
		await initializeRuntime(runtime, { sync: vi.fn(async () => createEmptySyncResult()), saveHistoryCheckpoint });
		const operation = runtime.sync();
		await vi.waitFor(() => expect(saveHistoryCheckpoint).toHaveBeenCalledOnce());
		const entry = settings.syncHistory[0]!;
		runtime.destroy();
		checkpoint.resolve('obsolete-checkpoint');
		await operation;
		expect(entry).not.toHaveProperty('historyCheckpoint');
		expect(persistSettings).not.toHaveBeenCalled();
	});

	it.each(['sync', 'initialSync', 'forceFullSync'] as const)('shows saving progress until %s history and settings are persisted', async method => {
		const { runtime, persistSettings } = createRuntimeHarness();
		const checkpoint = createDeferred<undefined>();
		const persistence = createDeferred<void>();
		const state = { status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 } as const;
		const sync = vi.fn(async () => createEmptySyncResult());
		const engine = {
			getState: () => state, sync, initialSync: sync, forceFullSync: sync,
			saveSharedHistoryCheckpoint: vi.fn(() => checkpoint.promise),
		};
		await initializeRuntime(runtime, engine);
		persistSettings.mockImplementation(() => persistence.promise);
		const labels: string[] = [];
		runtime.addProgressListener(() => {
			if (runtime.getActivityProgress()) labels.push(formatSyncProgress(runtime.getActivityProgress(), runtime.getState().work));
		});

		const operation = runtime[method]();
		await vi.waitFor(() => expect(engine.saveSharedHistoryCheckpoint).toHaveBeenCalledOnce());
		expect(labels.at(-1)).toBe('Saving sync progress…');
		expect(formatSyncProgress(runtime.getActivityProgress(), runtime.getState().work)).toBe('Saving sync progress…');

		checkpoint.resolve(undefined);
		await vi.waitFor(() => expect(persistSettings).toHaveBeenCalledOnce());
		expect(formatSyncProgress(runtime.getActivityProgress(), runtime.getState().work)).toBe('Saving sync progress…');
		persistence.resolve();
		await operation;
		expect(runtime.getActivityProgress()).toBeNull();
	});

	it.each([
		{ method: (runtime: SyncRuntime, callback: (current: number, total: number) => void) => runtime.sync(callback), historyType: 'sync' as const },
		{ method: (runtime: SyncRuntime, callback: (current: number, total: number) => void) => runtime.initialSync(callback), historyType: 'initial' as const },
		{ method: (runtime: SyncRuntime, callback: (current: number, total: number) => void) => runtime.forceFullSync(callback), historyType: 'force' as const },
	])('records history, persists settings, and clears progress for $method', async ({ method, historyType }) => {
		const { runtime, persistSettings, settings } = createRuntimeHarness({}, async () => { throw new Error('reminder settings unavailable'); });
		const result: SyncResult = {
			...createEmptySyncResult(),
			success: false,
			errors: ['Upload failed: notes/b.md'],
			uploaded: 2,
			uploadedPaths: ['notes/a.md'],
			conflicts: ['notes/a (conflict 2026-01-02 03-04-05 ab12).md'],
			resolvedRaces: [{ path: 'notes/restored.md', resolution: 'kept-remote-edit' }],
		};
		const progressCallback = vi.fn(() => {
			expect(runtime.getActivityProgress()).toEqual({ type: historyType, current: 1, total: 2 });
		});
		const listener = vi.fn();

		await initializeRuntime(runtime, {
			sync: vi.fn(async (callback: (current: number, total: number) => void) => {
				callback(1, 2);
				return result;
			}),
			initialSync: vi.fn(async (callback: (current: number, total: number) => void) => {
				callback(1, 2);
				return result;
			}),
			forceFullSync: vi.fn(async (callback: (current: number, total: number) => void) => {
				callback(1, 2);
				return result;
			}),
		});

		runtime.addProgressListener(listener);

		const methodResult = await method(runtime, progressCallback);

		expect(settings.syncHistory[0]?.errors).toEqual(result.errors);
		expect(normalizeCrateSettings(settings, '.obsidian').syncHistory[0]?.errors).toEqual(result.errors);
		expect(methodResult).toBe(result);
		expect(runtime.getActivityProgress()).toBeNull();
		expect(progressCallback).toHaveBeenCalledWith(1, 2);
		expect(listener).toHaveBeenCalledWith(1, 2);
		expect(listener).toHaveBeenLastCalledWith(0, 0);
		expect(persistSettings).toHaveBeenCalledTimes(1);
		expect(settings.syncHistory[0]?.type).toBe(historyType);
		expect(settings.syncHistory[0]?.uploaded).toBe(2);
		expect(settings.syncHistory[0]?.conflictPaths).toEqual(result.conflicts);
		expect(settings.syncHistory[0]?.resolvedRaces).toEqual(result.resolvedRaces);
	});

	it('caps stored sync history file paths', async () => {
		const { runtime, settings } = createRuntimeHarness();
		const uploadedPaths = Array.from({ length: MAX_SYNC_HISTORY_PATHS + 5 }, (_, index) => `notes/${index}.md`);

		await initializeRuntime(runtime, {
			sync: vi.fn(async () => ({
				...createEmptySyncResult(),
				success: true,
				uploaded: uploadedPaths.length,
				uploadedPaths,
			})),
			initialSync: vi.fn(async () => createEmptySyncResult()),
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		});

		await runtime.sync();

		expect(settings.syncHistory[0]?.uploadedPaths).toHaveLength(MAX_SYNC_HISTORY_PATHS);
		expect(settings.syncHistory[0]?.uploadedPaths?.at(-1)).toBe(`notes/${MAX_SYNC_HISTORY_PATHS - 1}.md`);
	});

	it('records, persists, and announces automatic queue sync activity', async () => {
		const { runtime, persistSettings, settings } = createRuntimeHarness();
		const state = {
			status: 'idle' as const,
			lastSync: '2026-02-15T12:00:00.000Z',
			lastError: null,
			pendingChanges: 0,
			conflictCount: 0,
		};
		const engine = {
			getState: () => state,
			sync: vi.fn(async () => createEmptySyncResult()),
			initialSync: vi.fn(async () => createEmptySyncResult()),
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		};
		const result: SyncResult = {
			...createEmptySyncResult(),
			uploaded: 1,
			uploadedPaths: ['notes/automatic.md'],
		};
		const listener = vi.fn();
		const callback = vi.spyOn(SyncEngine.prototype, 'setAutomaticSyncResultCallback');
		await initializeRuntime(runtime, engine);
		runtime.addStateChangeListener(listener);

		await callback.mock.calls[0]![0](result);

		expect(settings.lastSync).toBe(state.lastSync);
		expect(settings.syncHistory[0]).toEqual(expect.objectContaining({
			type: 'sync',
			uploaded: 1,
			uploadedPaths: ['notes/automatic.md'],
		}));
		expect(listener).toHaveBeenCalledWith(state);
		expect(persistSettings).toHaveBeenCalledTimes(1);
	});

	it('resets sync state when applying infrastructure config', async () => {
		const { runtime, settings } = createRuntimeHarness({
			lastSeq: 42,
			lastSync: '2026-01-01T00:00:00.000Z',
			syncHistory: [
				{
					timestamp: '2026-01-01T00:00:00.000Z',
					type: 'sync',
					success: true,
					uploaded: 1,
					downloaded: 0,
					merged: 0,
					deleted: 0,
					errorCount: 0,
					conflictCount: 0,
				},
			],
		});
		const initialize = vi.spyOn(runtime, 'initialize').mockResolvedValue(undefined);

		await runtime.applyInfrastructureConfig({
			workerUrl: 'https://new-worker.example',
			authToken: ' new-auth-token ',
		});

		expect(settings.lastSeq).toBe(0);
		expect(settings.lastSync).toBeNull();
		expect(settings.syncHistory).toEqual([]);
		expect(initialize).toHaveBeenCalledWith({ skipStartupSync: true });
	});

	it('clears sync state when clearing configuration', async () => {
		const { runtime, settings } = createRuntimeHarness({
			cloudflareDeployment: {
				deploymentId: '0123456789abcdef',
				accountId: '0123456789abcdef0123456789abcdef',
				accountName: 'Example',
				workerName: 'crate-0123456789abcdef',
				d1DatabaseName: 'crate-0123456789abcdef',
				d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
				r2BucketName: 'crate-0123456789abcdef',
				workersSubdomain: 'crate-example',
				lastDeployedVersion: '0.1.0',
				lastDeployedFingerprint: 'f'.repeat(64),
			},
			lastSeq: 42,
			lastSync: '2026-01-01T00:00:00.000Z',
			syncHistory: [
				{
					timestamp: '2026-01-01T00:00:00.000Z',
					type: 'sync',
					success: true,
					uploaded: 1,
					downloaded: 0,
					merged: 0,
					deleted: 0,
					errorCount: 0,
					conflictCount: 0,
				},
			],
		});
		const revokeCurrentToken = vi.fn(async () => ({ success: true }));
		await initializeRuntime(runtime);
		mockApiClient(runtime, {
			putSharedSettings: vi.fn(async () => ({ success: true, settingsVersion: 'test' })),
			testConnection: vi.fn(async () => ({ success: true })),
			revokeCurrentToken,
		});

		await runtime.clearSyncConfiguration();

		expect(settings.lastSeq).toBe(0);
		expect(settings.lastSync).toBeNull();
		expect(settings.syncHistory).toEqual([]);
		expect(settings.workerUrl).toBe('');
		expect(revokeCurrentToken).toHaveBeenCalledTimes(1);
		expect(settings.cloudflareDeployment).toEqual(expect.objectContaining({
			workerName: 'crate-0123456789abcdef',
		}));
	});

	it('caps stored sync history entries', async () => {
		const { runtime, settings } = createRuntimeHarness();

		await initializeRuntime(runtime, {
			sync: vi.fn(async () => createEmptySyncResult()),
			initialSync: vi.fn(async () => createEmptySyncResult()),
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		});

		for (let index = 0; index < MAX_SYNC_HISTORY + 5; index++) {
			await runtime.sync();
		}

		expect(settings.syncHistory).toHaveLength(MAX_SYNC_HISTORY);
	});

	it('pushes shared settings through the current API client', async () => {
		const { runtime } = createRuntimeHarness({
			ignorePatterns: ['*.tmp'],
			syncOnStartup: false,
			syncOnResume: false,
			syncInterval: 15,
			pushEnabled: true,
		});
		const putSharedSettings = vi.fn(async () => ({ success: true, settingsVersion: 'test' }));
		await initializeRuntime(runtime);
		mockApiClient(runtime, {
			putSharedSettings,
			testConnection: vi.fn(async () => ({ success: true })),
		});

		await expect(runtime.pushSharedSettingsBestEffort()).resolves.toBe(true);

		expect(putSharedSettings).toHaveBeenCalledWith({
			ignorePatterns: ['*.tmp'],
			syncOnStartup: false,
			syncOnResume: false,
			syncInterval: 15,
			pushEnabled: true,
		});
	});

	it('reports shared settings push failures without rejecting', async () => {
		const { runtime } = createRuntimeHarness();
		const pushError = new Error('server unavailable');
		await initializeRuntime(runtime);
		mockApiClient(runtime, {
			putSharedSettings: vi.fn(async () => {
				throw pushError;
			}),
			testConnection: vi.fn(async () => ({ success: true })),
		});
		const logError = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(runtime.pushSharedSettingsBestEffort()).resolves.toBe(false);

		expect(logError).toHaveBeenCalledWith(
			'[Crate] [SyncRuntime]',
			'Failed to push shared settings:',
			pushError,
		);
	});

	it('delegates connection tests to the API client when configured', async () => {
		const { runtime } = createRuntimeHarness();
		const testConnection = vi.fn(async () => ({ success: false, error: 'boom' }));
		await initializeRuntime(runtime);
		mockApiClient(runtime, {
			putSharedSettings: vi.fn(async () => ({ success: true, settingsVersion: 'test' })),
			testConnection,
		});

		await expect(runtime.testConnection()).resolves.toEqual({ success: false, error: 'boom' });
		expect(testConnection).toHaveBeenCalledTimes(1);
	});
});
