import { describe, expect, it, vi } from 'vitest';
import {
	createHarness,
	createNamedAbortError,
	spyOnConflictRecovery,
	spyOnIncrementalSync,
	spyOnPrepareUploadsFromVaultFiles,
	toArrayBuffer,
} from './engine-test-harness';
import { createDeferred } from './runtime-test-harness';
import { computeHash } from './hasher';

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
	it.each(['incremental', 'full'] as const)('preserves the baseline when %s hashing finishes after cancellation', async mode => {
		const harness = createHarness({ automaticSync: false, lastSeq: 42 });
		const content = toArrayBuffer('unchanged');
		const baseline = { hash: await computeHash(content), size: content.byteLength, modified: new Date(1000).toISOString() };
		harness.localManifest.setEntry('note.md', baseline);
		harness.localManifest.setEntry.mockClear();
		harness.vault.getFiles.mockReturnValue([{ path: 'note.md', extension: 'md', stat: { size: content.byteLength, mtime: 2000 } }]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.api.getChanges.mockResolvedValue({ changes: [], lastSeq: 43, hasMore: false });
		harness.api.getManifest.mockResolvedValue({ version: 1, files: { 'note.md': baseline } });
		if (mode === 'full') spyOnIncrementalSync(harness.engine, null);
		const read = createDeferred<ArrayBuffer>();
		harness.vault.adapter.readBinary.mockReturnValue(read.promise);
		const syncing = harness.engine.sync();
		await vi.waitFor(() => expect(harness.vault.adapter.readBinary).toHaveBeenCalled());
		harness.engine.destroy();
		const stopped = harness.engine.waitForIdle();
		read.resolve(content);
		await syncing;
		await stopped;

		expect(harness.localManifest.setEntry).not.toHaveBeenCalled();
		expect(harness.localManifest.removeEntry).not.toHaveBeenCalled();
		expect(harness.localManifest.getEntry('note.md')).toEqual(baseline);
		expect(harness.api.batchUpload).not.toHaveBeenCalled();
		expect(harness.settings.lastSeq).toBe(42);
	});

	it.each(['sync', 'initialSync', 'forceFullSync'] as const)('drains %s without continuing a cancelled vault scan or advancing the cursor', async operation => {
		const harness = createHarness({ automaticSync: false, lastSeq: 42 });
		const listed = createDeferred<void>();
		const listing = createDeferred<{ files: string[]; folders: string[] }>();
		harness.api.getChanges.mockResolvedValue({ changes: [], lastSeq: 43, hasMore: false });
		harness.api.getManifest.mockResolvedValue({ version: 1, files: {} });
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockImplementation(async path => {
			if (path === '') { listed.resolve(); return listing.promise; }
			return { files: [], folders: [] };
		});
		const syncing = harness.engine[operation]();
		await listed.promise;
		harness.engine.destroy();
		const stopped = harness.engine.waitForIdle();
		listing.resolve({ files: [], folders: ['.config', 'notes'] });
		const result = await syncing;
		await stopped;

		expect(harness.vault.adapter.list).toHaveBeenCalledExactlyOnceWith('');
		expect(harness.vault.adapter.readBinary).not.toHaveBeenCalled();
		expect(harness.api.batchUpload).not.toHaveBeenCalled();
		expect(harness.api.batchDelete).not.toHaveBeenCalled();
		expect(harness.settings.lastSeq).toBe(42);
		expect(harness.settings.lastSync).toBeNull();
		expect(result.errors).toEqual([]);
	});

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
		vi.useFakeTimers();
		const harness = createHarness({ syncInterval: 60 });
		harness.api.checkForChanges.mockRejectedValue(new Error('network error'));
		try {
			await harness.engine.initialize();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(harness.api.checkForChanges).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(harness.api.checkForChanges).toHaveBeenCalledTimes(2);
			harness.engine.updateSettings({ ...harness.settings, syncInterval: 60 });
			// Two failures would ordinarily defer the next request for 120 seconds.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(harness.api.checkForChanges).toHaveBeenCalledTimes(3);
		} finally {
			harness.engine.destroy();
			vi.useRealTimers();
		}
	});
});
