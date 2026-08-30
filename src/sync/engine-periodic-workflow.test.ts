import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPeriodicCheckWorkflow, type PeriodicCheckWorkflowContext } from './engine-periodic-workflow';
import { createEmptySyncResult } from './sync-result';

function createContext(overrides: Partial<{
	checkForChanges: PeriodicCheckWorkflowContext['checkForChanges'];
	hiddenFilesChanged: boolean;
	pendingPathCount: number;
	syncIntervalSeconds: number;
}> = {}) {
	let consecutiveCheckFailures = 0;
	let lastCheckAttempt = 0;
	const checkForChanges = vi.fn(
		overrides.checkForChanges ?? (async () => ({ hasChanges: false })),
	);
	const sync = vi.fn(async () => createEmptySyncResult());

	return {
		checkForChanges,
		getFailures: () => consecutiveCheckFailures,
		sync,
		context: {
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
			hasHiddenFileChanges: async () => overrides.hiddenFilesChanged ?? false,
			checkForChanges,
			sync,
		},
	};
}

describe('runPeriodicCheckWorkflow', () => {
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

	it('syncs when hidden files changed without remote changes', async () => {
		const harness = createContext({ hiddenFilesChanged: true });

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
