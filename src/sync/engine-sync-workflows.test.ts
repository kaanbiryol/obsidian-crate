import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from './runtime-test-harness';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import {
	createHarness,
	toArrayBuffer,
} from './engine-test-harness';

afterEach(() => { vi.useRealTimers(); });

describe('SyncEngine incremental sync cursor/state safeguards', () => {
	it('sets state to error when incremental sync returns errors', async () => {
		const harness = createHarness({ lastSeq: 1 });
		harness.api.getChanges.mockResolvedValue({
			changes: [
				{
					seq: 2,
					path: 'notes/remote.md',
					action: 'put',
					hash: 'remote-hash',
					size: 10,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 2,
			hasMore: false,
		});
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.api.batchDownload.mockRejectedValue(new Error('network down'));
		harness.api.downloadFile.mockRejectedValue(new Error('network down'));

		const result = await harness.engine.sync();
		const state = harness.engine.getState();

		expect(result.success).toBe(false);
		expect(state.status).toBe('error');
		expect(state.lastError).toBe('notes/remote.md: network down');
		expect(harness.settings.lastSeq).toBe(1);
	});
});
describe('SyncEngine full sync safeguards', () => {
	it('skips ignored remote paths during full sync reconciliation', async () => {
		const harness = createHarness({ lastSeq: 0 });
		harness.api.getManifest.mockResolvedValue({
			version: 1,
			files: {
				'.trash/remote.md': {
					hash: 'remote-hash',
					size: 10,
					modified: '2026-02-06T12:00:00.000Z',
				},
			},
			lastSeq: 3,
		});
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: ['.trash'] });

		const result = await harness.engine.sync();

		expect(result.success).toBe(true);
		expect(result.downloaded).toBe(0);
		expect(harness.api.downloadFile).not.toHaveBeenCalled();
	});

	it('does not advance lastSeq when full sync has non-fatal errors', async () => {
		const harness = createHarness({ lastSeq: 5 });
		harness.api.getChanges.mockResolvedValue({ changes: [], lastSeq: 5, hasMore: false, cursorExpired: true });
		harness.api.getManifest.mockResolvedValue({
			version: 1,
			files: {
				'notes/big.bin': {
					hash: 'remote-big',
					size: MAX_FILE_SIZE_BYTES + 1,
					modified: '2026-02-06T12:00:00.000Z',
				},
			},
			lastSeq: 9,
		});
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });

		const result = await harness.engine.sync();

		expect(result.success).toBe(false);
		expect(result.errors).toContain('notes/big.bin: Skipped remote file larger than 25MB');
		expect(harness.settings.lastSeq).toBe(5);
	});

});

describe('SyncEngine slice 5 safeguards', () => {
	it('rejects initial sync while another sync is in progress', async () => {
		const harness = createHarness();
		const gate = createDeferred<void>();
		harness.api.getManifest.mockImplementation(async () => {
			await gate.promise;
			return { version: 1, files: {}, lastSeq: 1 };
		});
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		const running = harness.engine.sync();
		await vi.waitFor(() => expect(harness.api.getManifest).toHaveBeenCalledOnce());

		const result = await harness.engine.initialSync();

		expect(result.success).toBe(false);
		expect(result.errors).toEqual(['Sync already in progress']);
		expect(harness.vault.getFiles).not.toHaveBeenCalled();
		gate.resolve();
		expect((await running).success).toBe(true);
		harness.engine.destroy();
	});

	it('sets state to error when initial sync finishes with per-file errors', async () => {
		const harness = createHarness();
		const file = {
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime: 1700000000000 },
		};
		harness.vault.getFiles.mockReturnValue([file]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('A'));
		harness.api.batchUpload.mockResolvedValue({
			success: false,
			results: [{ path: 'notes/a.md', success: false, error: 'quota exceeded' }],
		});

		const result = await harness.engine.initialSync();
		const state = harness.engine.getState();

		expect(result.success).toBe(false);
		expect(result.errors).toContain('notes/a.md: quota exceeded');
		expect(state.status).toBe('error');
		expect(state.lastError).toBe('notes/a.md: quota exceeded');
		expect(harness.settings.lastSync).toBeNull();
	});

		it('restats files during initial sync uploads', async () => {
		const harness = createHarness();
		const mtime = 1700000000000;
		const file = {
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime },
		};
		harness.vault.getFiles.mockReturnValue([file]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('A'));
		harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 1, mtime: mtime + 5000 });

		const result = await harness.engine.initialSync();

		expect(result.success).toBe(true);
			expect(harness.vault.adapter.stat).toHaveBeenCalledWith('notes/a.md');
			expect(harness.localManifest.setEntry).toHaveBeenCalledWith(
				'notes/a.md',
				expect.objectContaining({ modified: new Date(mtime + 5000).toISOString() }),
			);
	});

	it('sets state to error when force full sync finishes with non-fatal errors', async () => {
		const harness = createHarness();
		harness.api.getManifest.mockResolvedValue({
			version: 1,
			files: {
				'notes/remote-only.md': {
					hash: 'remote-hash',
          revision: 'version-1',
					size: 3,
					modified: '2026-02-06T12:00:00.000Z',
				},
			},
		});
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.api.deleteFile.mockRejectedValue(new Error('remote locked'));

		const result = await harness.engine.forceFullSync();
		const state = harness.engine.getState();

		expect(result.success).toBe(false);
		expect(result.errors).toContain('notes/remote-only.md: remote locked');
		expect(state.status).toBe('error');
		expect(state.lastError).toBe('notes/remote-only.md: remote locked');
		expect(harness.settings.lastSync).toBeNull();
	});

	it('does not delete ignored remote-only paths during force full sync', async () => {
		const harness = createHarness();
		harness.api.getManifest.mockResolvedValue({
			version: 1,
			files: {
				'.trash/old.md': {
					hash: 'ignored-hash',
					size: 10,
					modified: '2026-02-06T12:00:00.000Z',
				},
				'notes/remote-only.md': {
					hash: 'remote-hash',
          revision: 'version-1',
					size: 3,
					modified: '2026-02-06T12:00:00.000Z',
				},
			},
		});
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.api.deleteFile.mockResolvedValue({ success: true, path: 'notes/remote-only.md' });

		const result = await harness.engine.forceFullSync();

		expect(result.success).toBe(true);
		expect(result.deleted).toBe(1);
		expect(harness.api.deleteFile).toHaveBeenCalledTimes(1);
		expect(harness.api.deleteFile).toHaveBeenCalledWith('notes/remote-only.md', 'remote-hash', 'version-1');
		expect(harness.api.deleteFile).not.toHaveBeenCalledWith('.trash/old.md');
	});

	it('does not reschedule debounced sync after destroy during a pending flush', async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		const content = toArrayBuffer('A');
		let releaseUpload!: () => void;
		let signalUploadStarted!: () => void;
		const uploadGate = new Promise<void>(resolve => {
			releaseUpload = () => resolve();
		});
		const uploadStarted = new Promise<void>(resolve => {
			signalUploadStarted = () => resolve();
		});

		harness.vault.getAbstractFileByPath.mockImplementation((path: string) => {
			if (path === 'notes/a.md') {
				return {
					path,
					extension: 'md',
					stat: { size: 1, mtime: 1700000000000 },
				};
			}
			return null;
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		harness.api.uploadFile.mockImplementation(async () => {
			signalUploadStarted();
			harness.engine.onFileChange({ path: 'notes/b.md' } as never);
			await uploadGate;
			return { success: true, path: 'notes/a.md' };
		});

		harness.engine.onFileChange({ path: 'notes/a.md' } as never);
		await vi.advanceTimersByTimeAsync(5000);
		await uploadStarted;

		harness.engine.destroy();
		releaseUpload();
		await harness.engine.waitForIdle();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(harness.api.uploadFile).toHaveBeenCalledOnce();
		expect(harness.engine.getPendingPaths()).toEqual([]);
	});
});
