import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPeriodicCheckWorkflow, type PeriodicCheckWorkflowContext } from './engine-periodic-workflow';
import { cancelSyncResult, createEmptySyncResult } from './sync-result';

function createContext(overrides: Partial<{
	checkForChanges: PeriodicCheckWorkflowContext['checkForChanges'];
	localFilesChanged: boolean;
	pendingPathCount: number;
	syncIntervalSeconds: number;
}> = {}) {
	let consecutiveCheckFailures = 0;
	let lastCheckAttempt = 0;
	const checkForChanges = vi.fn(
		overrides.checkForChanges ?? (async () => ({ hasChanges: false })),
	);
	const sync = vi.fn(async () => createEmptySyncResult());
	const hasLocalFileChanges = vi.fn(async () => overrides.localFilesChanged ?? false);

	return {
		checkForChanges,
		hasLocalFileChanges,
		getFailures: () => consecutiveCheckFailures,
		sync,
		context: {
			automaticSyncEnabled: () => true,
			apiConfigured: () => true,
			getStatus: () => 'idle' as const,
			getSyncIntervalSeconds: () => overrides.syncIntervalSeconds ?? 60,
			getLastSeq: () => 10,
			getPendingPathCount: () => overrides.pendingPathCount ?? 0,
			getConsecutiveCheckFailures: () => consecutiveCheckFailures,
			setConsecutiveCheckFailures: (value: number) => {
				consecutiveCheckFailures = value;
			},
			getLastCheckAttempt: () => lastCheckAttempt,
			setLastCheckAttempt: (value: number) => {
				lastCheckAttempt = value;
			},
			hasLocalFileChanges,
			checkForChanges,
			sync,
			onCheckSuccess: vi.fn(),
			onCheckFailure: vi.fn(),
		},
	};
}

describe('runPeriodicCheckWorkflow', () => {
	it('does not count a cancelled sync as a failed periodic check', async () => {
		const harness = createContext({ localFilesChanged: true });
		harness.sync.mockResolvedValue(cancelSyncResult(createEmptySyncResult()));
		await runPeriodicCheckWorkflow(harness.context);
		expect(harness.getFailures()).toBe(0);
		expect(harness.context.onCheckFailure).not.toHaveBeenCalled();
	});

	it('does not check or sync when periodic syncing is disabled', async () => {
		const harness = createContext({ localFilesChanged: true });
		harness.context.automaticSyncEnabled = () => false;
		await runPeriodicCheckWorkflow(harness.context);
		expect(harness.checkForChanges).not.toHaveBeenCalled();
		expect(harness.sync).not.toHaveBeenCalled();
	});

	it('does not start a sync if disabled during a periodic check', async () => {
		const harness = createContext({ localFilesChanged: true });
		harness.checkForChanges.mockImplementation(async () => {
			harness.context.automaticSyncEnabled = () => false;
			return { hasChanges: true };
		});
		await runPeriodicCheckWorkflow(harness.context);
		expect(harness.sync).not.toHaveBeenCalled();
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

		await runPeriodicCheckWorkflow(harness.context);
		expect(harness.getFailures()).toBe(1);

		vi.mocked(Date.now).mockReturnValue(now + 61_000);
		await runPeriodicCheckWorkflow(harness.context);

		expect(harness.getFailures()).toBe(2);
	});

	it('resets failure counter on successful check', async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const harness = createContext();
		harness.checkForChanges
			.mockRejectedValueOnce(new Error('network error'))
			.mockResolvedValueOnce({ hasChanges: false });

		await runPeriodicCheckWorkflow(harness.context);
		expect(harness.getFailures()).toBe(1);

		vi.mocked(Date.now).mockReturnValue(now + 120_000);
		await runPeriodicCheckWorkflow(harness.context);

		expect(harness.getFailures()).toBe(0);
	});

	it('syncs when local files changed without remote changes', async () => {
		const harness = createContext({ localFilesChanged: true });

		await runPeriodicCheckWorkflow(harness.context);

		expect(harness.sync).toHaveBeenCalledTimes(1);
	});

	it('syncs when the remote changelog cursor expired even if no rows remain', async () => {
		const harness = createContext({
			checkForChanges: async () => ({ hasChanges: false, cursorExpired: true }),
		});

		await runPeriodicCheckWorkflow(harness.context);

		expect(harness.sync).toHaveBeenCalledTimes(1);
	});

	it.each([
		['the server has changes', { checkForChanges: async () => ({ hasChanges: true }) }],
		['the server cursor expired', { checkForChanges: async () => ({ hasChanges: false, cursorExpired: true }) }],
		['local edits are queued', { pendingPathCount: 2 }],
	])('leaves the vault walk to the sync when %s', async (_label, overrides) => {
		const harness = createContext(overrides);

		await runPeriodicCheckWorkflow(harness.context);

		expect(harness.hasLocalFileChanges).not.toHaveBeenCalled();
		expect(harness.sync).toHaveBeenCalledTimes(1);
	});

	it('walks the vault once on an idle check and not after a failed server check', async () => {
		const harness = createContext();
		await runPeriodicCheckWorkflow(harness.context);
		expect(harness.hasLocalFileChanges).toHaveBeenCalledTimes(1);
		expect(harness.sync).not.toHaveBeenCalled();

		const failing = createContext({ checkForChanges: async () => { throw new Error('network error'); } });
		await runPeriodicCheckWorkflow(failing.context);
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

		await runPeriodicCheckWorkflow(harness.context);
		await runPeriodicCheckWorkflow(harness.context);

		expect(harness.checkForChanges).toHaveBeenCalledTimes(1);
	});
});
