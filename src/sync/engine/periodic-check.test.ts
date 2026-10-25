import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncEngineLifecycle } from './lifecycle';
import { cancelSyncResult, createEmptySyncResult } from '../sync-result';
import type { SyncResult } from '../types';

function createContext(overrides: Partial<{
	checkForChanges: (lastSeq: number) => Promise<{ hasChanges: boolean; cursorExpired?: boolean }>;
	localFilesChanged: boolean;
	pendingPathCount: number;
	syncIntervalSeconds: number;
}> = {}) {
	let automaticSync = true;
	let status: 'idle' | 'syncing' = 'idle';
	const checkForChanges = vi.fn(
		overrides.checkForChanges ?? (async () => ({ hasChanges: false })),
	);
	const sync = vi.fn(async (): Promise<SyncResult> => createEmptySyncResult());
	const hasLocalFileChanges = vi.fn(async () => overrides.localFilesChanged ?? false);
	const dependencies = {
		automaticSyncEnabled: () => automaticSync,
		apiConfigured: () => true,
		getStatus: () => status,
		getSyncIntervalSeconds: () => overrides.syncIntervalSeconds ?? 60,
		getLastSeq: () => 10,
		getPendingPathCount: () => overrides.pendingPathCount ?? 0,
		hasLocalFileChanges,
		checkForChanges,
		sync,
		onCheckSuccess: vi.fn(),
		onCheckFailure: vi.fn(),
	};
	const lifecycle = new SyncEngineLifecycle(dependencies);

	return {
		checkForChanges,
		hasLocalFileChanges,
		getFailures: () => lifecycle.checkFailureCount,
		setAutomaticSync: (enabled: boolean) => { automaticSync = enabled; },
		setStatus: (value: 'idle' | 'syncing') => { status = value; },
		sync,
		dependencies,
		lifecycle,
	};
}

describe('SyncEngineLifecycle periodic check', () => {
	it('does not count a cancelled sync as a failed periodic check', async () => {
		const harness = createContext({ localFilesChanged: true });
		harness.sync.mockResolvedValue(cancelSyncResult(createEmptySyncResult()));
		await harness.lifecycle.periodicCheck();
		expect(harness.getFailures()).toBe(0);
		expect(harness.dependencies.onCheckFailure).not.toHaveBeenCalled();
	});

	it('does not check or sync when periodic syncing is disabled', async () => {
		const harness = createContext({ localFilesChanged: true });
		harness.setAutomaticSync(false);
		await harness.lifecycle.periodicCheck();
		expect(harness.checkForChanges).not.toHaveBeenCalled();
		expect(harness.sync).not.toHaveBeenCalled();
	});

	it('does not start a sync if disabled during a periodic check', async () => {
		const harness = createContext({ localFilesChanged: true });
		harness.checkForChanges.mockImplementation(async () => {
			harness.setAutomaticSync(false);
			return { hasChanges: true };
		});
		await harness.lifecycle.periodicCheck();
		expect(harness.sync).not.toHaveBeenCalled();
	});

	it('leaves a sync that started during the check alone instead of recording a refused attempt', async () => {
		const harness = createContext();
		harness.checkForChanges.mockImplementation(async () => {
			// A debounced queue flush starts while the check awaits the network.
			harness.setStatus('syncing');
			return { hasChanges: true };
		});
		await harness.lifecycle.periodicCheck();
		expect(harness.sync).not.toHaveBeenCalled();
		expect(harness.getFailures()).toBe(0);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('increments failure counter on consecutive check failures', async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const harness = createContext({
			checkForChanges: async () => {
				throw new Error('network error');
			},
		});

		await harness.lifecycle.periodicCheck();
		expect(harness.getFailures()).toBe(1);

		vi.mocked(Date.now).mockReturnValue(now + 61_000);
		await harness.lifecycle.periodicCheck();

		expect(harness.getFailures()).toBe(2);
	});

	it('resets failure counter on successful check', async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const harness = createContext();
		harness.checkForChanges
			.mockRejectedValueOnce(new Error('network error'))
			.mockResolvedValueOnce({ hasChanges: false });

		await harness.lifecycle.periodicCheck();
		expect(harness.getFailures()).toBe(1);

		vi.mocked(Date.now).mockReturnValue(now + 120_000);
		await harness.lifecycle.periodicCheck();

		expect(harness.getFailures()).toBe(0);
	});

	it('syncs when local files changed without remote changes', async () => {
		const harness = createContext({ localFilesChanged: true });

		await harness.lifecycle.periodicCheck();

		expect(harness.sync).toHaveBeenCalledTimes(1);
	});

	it('syncs when the remote changelog cursor expired even if no rows remain', async () => {
		const harness = createContext({
			checkForChanges: async () => ({ hasChanges: false, cursorExpired: true }),
		});

		await harness.lifecycle.periodicCheck();

		expect(harness.sync).toHaveBeenCalledTimes(1);
	});

	it.each([
		['the server has changes', { checkForChanges: async () => ({ hasChanges: true }) }],
		['the server cursor expired', { checkForChanges: async () => ({ hasChanges: false, cursorExpired: true }) }],
		['local edits are queued', { pendingPathCount: 2 }],
	])('leaves the vault walk to the sync when %s', async (_label, overrides) => {
		const harness = createContext(overrides);

		await harness.lifecycle.periodicCheck();

		expect(harness.hasLocalFileChanges).not.toHaveBeenCalled();
		expect(harness.sync).toHaveBeenCalledTimes(1);
	});

	it('walks the vault once on an idle check and not after a failed server check', async () => {
		const harness = createContext();
		await harness.lifecycle.periodicCheck();
		expect(harness.hasLocalFileChanges).toHaveBeenCalledTimes(1);
		expect(harness.sync).not.toHaveBeenCalled();

		const failing = createContext({ checkForChanges: async () => { throw new Error('network error'); } });
		await failing.lifecycle.periodicCheck();
		expect(failing.hasLocalFileChanges).not.toHaveBeenCalled();
	});

	it('skips checks within the backoff window after a failure', async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const harness = createContext({
			checkForChanges: async () => {
				throw new Error('network error');
			},
		});

		await harness.lifecycle.periodicCheck();
		await harness.lifecycle.periodicCheck();

		expect(harness.checkForChanges).toHaveBeenCalledTimes(1);
	});
});
