import { describe, expect, it, vi } from 'vitest';
import { MAX_SYNC_HISTORY, MAX_SYNC_HISTORY_PATHS } from '../plugin/settings-types';
import type { SyncResult } from './types';
import { createEmptySyncResult } from './sync-result';
import { SyncRuntime } from './runtime';
import {
	createRuntimeHarness,
	setApiClient,
	setStatusBar,
	setSyncEngine,
} from './runtime-test-harness';

describe('SyncRuntime operation wrappers', () => {
	it.each([
		{ method: (runtime: SyncRuntime, callback: (current: number, total: number) => void) => runtime.sync(callback), historyType: 'sync' as const },
		{ method: (runtime: SyncRuntime, callback: (current: number, total: number) => void) => runtime.initialSync(callback), historyType: 'initial' as const },
		{ method: (runtime: SyncRuntime, callback: (current: number, total: number) => void) => runtime.forceFullSync(callback), historyType: 'force' as const },
	])('records history, persists settings, and clears progress for $method', async ({ method, historyType }) => {
		const { runtime, persistSettings, settings } = createRuntimeHarness();
		const result: SyncResult = {
			...createEmptySyncResult(),
			success: true,
			uploaded: 2,
			uploadedPaths: ['notes/a.md'],
			conflicts: ['notes/a (conflict 2026-01-02 03-04-05 ab12).md'],
			resolvedRaces: [{ path: 'notes/restored.md', resolution: 'kept-remote-edit' }],
		};
		const progressCallback = vi.fn();
		const listener = vi.fn();
		const clearSyncProgress = vi.fn();
		const setSyncProgress = vi.fn();

		setStatusBar(runtime, {
			setSyncProgress,
			clearSyncProgress,
		});
		setSyncEngine(runtime, {
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

		expect(methodResult).toBe(result);
		expect(progressCallback).toHaveBeenCalledWith(1, 2);
		expect(listener).toHaveBeenCalledWith(1, 2);
		expect(setSyncProgress).toHaveBeenCalledWith(1, 2);
		expect(clearSyncProgress).toHaveBeenCalledTimes(1);
		expect(persistSettings).toHaveBeenCalledTimes(1);
		expect(settings.syncHistory[0]?.type).toBe(historyType);
		expect(settings.syncHistory[0]?.uploaded).toBe(2);
		expect(settings.syncHistory[0]?.conflictPaths).toEqual(result.conflicts);
		expect(settings.syncHistory[0]?.resolvedRaces).toEqual(result.resolvedRaces);
	});

	it('caps stored sync history file paths', async () => {
		const { runtime, settings } = createRuntimeHarness();
		const uploadedPaths = Array.from({ length: MAX_SYNC_HISTORY_PATHS + 5 }, (_, index) => `notes/${index}.md`);

		setSyncEngine(runtime, {
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
			workerUrl: 'https://worker.example',
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
		setApiClient(runtime, {
			putSharedSettings: vi.fn(async () => {}),
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

		setSyncEngine(runtime, {
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
			showStatusBar: true,
			pushEnabled: true,
		});
		const putSharedSettings = vi.fn(async () => {});
		setApiClient(runtime, {
			putSharedSettings,
			testConnection: vi.fn(async () => ({ success: true })),
		});

		await expect(runtime.pushSharedSettingsBestEffort()).resolves.toBe(true);

		expect(putSharedSettings).toHaveBeenCalledWith({
			ignorePatterns: ['*.tmp'],
			syncOnStartup: false,
			syncOnResume: false,
			syncInterval: 15,
			showStatusBar: true,
			pushEnabled: true,
		});
	});

	it('reports shared settings push failures without rejecting', async () => {
		const { runtime } = createRuntimeHarness();
		const pushError = new Error('server unavailable');
		setApiClient(runtime, {
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
		setApiClient(runtime, {
			putSharedSettings: vi.fn(async () => {}),
			testConnection,
		});

		await expect(runtime.testConnection()).resolves.toEqual({ success: false, error: 'boom' });
		expect(testConnection).toHaveBeenCalledTimes(1);
	});
});
