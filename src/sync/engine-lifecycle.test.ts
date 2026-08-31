import { describe, expect, it, vi } from 'vitest';
import {
	createHarness,
	createNamedAbortError,
	getConsecutiveCheckFailures,
	runPeriodicCheck,
	setEngineLocalManifest,
	spyOnConflictRecovery,
	spyOnIncrementalSync,
	spyOnPrepareUploadsFromVaultFiles,
	toArrayBuffer,
} from './engine-test-harness';

describe('SyncEngine initialization', () => {
	it('defers conflict recovery until the workspace layout is ready', async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		const recoverFromVault = spyOnConflictRecovery(harness.engine).mockResolvedValue();
		try {
			await harness.engine.initialize();

			expect(harness.workspace.onLayoutReady).toHaveBeenCalledOnce();
			expect(recoverFromVault).not.toHaveBeenCalled();

			harness.workspace.runLayoutReady();
			expect(recoverFromVault).not.toHaveBeenCalled();

			await vi.runAllTimersAsync();
			expect(recoverFromVault).toHaveBeenCalledOnce();
		} finally {
			harness.engine.destroy();
			vi.useRealTimers();
		}
	});

	it('does not start deferred conflict recovery after destruction', async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		const recoverFromVault = spyOnConflictRecovery(harness.engine).mockResolvedValue();
		try {
			await harness.engine.initialize();
			harness.workspace.runLayoutReady();
			harness.engine.destroy();
			await vi.runAllTimersAsync();

			expect(recoverFromVault).not.toHaveBeenCalled();
		} finally {
			harness.engine.destroy();
			vi.useRealTimers();
		}
	});
});

describe('SyncEngine abort-on-destroy', () => {
	it('does not advance lastSeq when incremental sync is aborted', async () => {
		const harness = createHarness({ lastSeq: 5 });
		harness.api.getChanges.mockResolvedValue({
			changes: [
				{
					seq: 8,
					path: 'notes/remote.md',
					action: 'put',
					hash: 'remote-hash',
					size: 10,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 8,
			hasMore: false,
		});
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		// batchDownload throws AbortError (simulating destroy during download)
		harness.api.batchDownload.mockRejectedValue(
			new DOMException('signal is aborted without reason', 'AbortError'),
		);

		const result = await harness.engine.sync();

		expect(result.errors).toHaveLength(0);
		expect(harness.settings.lastSeq).toBe(5);
		expect(harness.engine.getState().status).not.toBe('error');
	});

	it('treats non-DOM AbortError objects as clean incremental aborts', async () => {
		const harness = createHarness({ lastSeq: 5 });
		harness.api.getChanges.mockResolvedValue({
			changes: [
				{
					seq: 8,
					path: 'notes/remote.md',
					action: 'put',
					hash: 'remote-hash',
					size: 10,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 8,
			hasMore: false,
		});
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.api.batchDownload.mockRejectedValue(createNamedAbortError());

		const result = await harness.engine.sync();

		expect(result.errors).toHaveLength(0);
		expect(harness.settings.lastSeq).toBe(5);
		expect(harness.engine.getState().status).not.toBe('error');
	});

	it('aborts in-flight sync when destroyed and does not set error state', async () => {
		const harness = createHarness({ lastSeq: 0 });
		// Make incremental sync fall through to full sync
		spyOnIncrementalSync(harness.engine, null);
		// getManifest will hang until we signal it
		let rejectManifest!: (error: Error) => void;
		const manifestCalled = new Promise<void>(resolve => {
			harness.api.getManifest.mockImplementation(() => new Promise((_res, rej) => {
				rejectManifest = rej;
				resolve();
			}));
		});

		const syncPromise = harness.engine.sync();
		await manifestCalled;

		// Destroy mid-flight - this aborts the controller
		harness.engine.destroy();
		// Simulate the fetch abort that would happen
		rejectManifest(createNamedAbortError('The operation was aborted'));

		const result = await syncPromise;

		// Should not have set error state (abort is not an error)
		expect(result.errors).toHaveLength(0);
		expect(harness.engine.getState().status).not.toBe('error');
	});

	it('initialSync aborts cleanly when destroyed during chunk processing', async () => {
		const harness = createHarness();
		const file = {
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime: 1700000000000 },
		};
		harness.vault.getFiles.mockReturnValue([file]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('A'));

		// Destroy during prepare phase
		spyOnPrepareUploadsFromVaultFiles(harness.engine, async () => {
			harness.engine.destroy();
			return [{ path: 'notes/a.md', content: toArrayBuffer('A'), hash: 'h', size: 1 }];
		});

		const result = await harness.engine.initialSync();

		// Should not have set error state
		expect(result.errors).toHaveLength(0);
		expect(harness.engine.getState().status).not.toBe('error');
	});

	it('forceFullSync aborts cleanly when destroyed after prepare', async () => {
		const harness = createHarness();
		harness.api.getManifest.mockResolvedValue({ version: 1, files: {} });
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });

		// Destroy after prepareUploadsFromVaultFiles
		spyOnPrepareUploadsFromVaultFiles(harness.engine, async () => {
			harness.engine.destroy();
			return [];
		});

		const result = await harness.engine.forceFullSync();

		expect(result.errors).toHaveLength(0);
		expect(harness.engine.getState().status).not.toBe('error');
	});
});

describe('SyncEngine periodic check backoff', () => {
	it('resets backoff on updateSettings', async () => {
		const harness = createHarness({ syncInterval: 60 });
		setEngineLocalManifest(harness.engine, harness.localManifest);
		harness.api.checkForChanges.mockRejectedValue(new Error('network error'));

		await runPeriodicCheck(harness.engine);
		expect(getConsecutiveCheckFailures(harness.engine)).toBe(1);

		harness.engine.updateSettings({ ...harness.settings, syncInterval: 60 });
		expect(getConsecutiveCheckFailures(harness.engine)).toBe(0);
	});
});
