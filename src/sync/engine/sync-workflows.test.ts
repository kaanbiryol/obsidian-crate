import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import {
	createHarness,
	toArrayBuffer,
} from './engine-test-harness';
import { Notice } from '../../test/mocks/obsidian';
import { AUTH_ERROR_MESSAGE } from '../sync-outcome';
import { HttpError } from '../worker-api/client';
import type { SyncResult } from '../types';

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

	it('reports a batch upload result rejected for revoked access with the reconnect message', async () => {
		Notice.reset();
		const harness = createHarness({ lastSeq: 0 });
		const file = { path: 'notes/a.md', extension: 'md', stat: { size: 1, mtime: 1700000000000 } };
		harness.api.getManifest.mockResolvedValue({ version: 1, files: {}, lastSeq: 3 });
		harness.vault.getFiles.mockReturnValue([file]);
		harness.vault.getAbstractFileByPath.mockReturnValue(file);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('A'));
		harness.api.batchUpload.mockResolvedValue({
			success: false,
			results: [{ path: 'notes/a.md', success: false, status: 401, error: 'Unauthorized' }],
		});

		const result = await harness.engine.sync();

		expect(harness.api.batchUpload).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ success: false, errors: ['notes/a.md: Unauthorized', AUTH_ERROR_MESSAGE] });
		expect(harness.engine.getState()).toMatchObject({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
		expect(Notice.messages).toEqual([AUTH_ERROR_MESSAGE]);
		expect(harness.settings).toMatchObject({ lastSync: null, lastSeq: 0 });
		harness.engine.destroy();
	});
});

describe('SyncEngine slice 5 safeguards', () => {
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
		harness.api.batchDelete.mockResolvedValue({ success: false, deleted: [], errors: [{ path: 'notes/remote-only.md', error: 'remote locked', status: 503 }] });

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

		const result = await harness.engine.forceFullSync();

		expect(result.success).toBe(true);
		expect(result.deleted).toBe(1);
		expect(harness.api.batchDelete).toHaveBeenCalledTimes(1);
		expect(harness.api.batchDelete).toHaveBeenCalledWith(['notes/remote-only.md'], { 'notes/remote-only.md': 'remote-hash' }, { 'notes/remote-only.md': 'version-1' });
		expect(harness.api.batchDelete).not.toHaveBeenCalledWith(expect.arrayContaining(['.trash/old.md']), expect.anything(), expect.anything());
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
		harness.api.batchUpload.mockImplementation(async () => {
			signalUploadStarted();
			harness.engine.onFileChange({ path: 'notes/b.md' } as never);
			await uploadGate;
			return { success: true, results: [{ success: true, path: 'notes/a.md' }] };
		});

		harness.engine.onFileChange({ path: 'notes/a.md' } as never);
		await vi.advanceTimersByTimeAsync(5000);
		await uploadStarted;

		harness.engine.destroy();
		releaseUpload();
		await harness.engine.waitForIdle();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(harness.api.batchUpload).toHaveBeenCalledOnce();
		expect(harness.engine.getPendingKeys()).toEqual([]);
	});
});

describe('SyncEngine per-file authorization failures', () => {
	const unauthorized = () => new HttpError('Unauthorized', 401);
	const remoteChange = { seq: 2, path: 'notes/remote.md', action: 'put', hash: 'remote-hash', size: 10, created_at: '2026-02-06T12:00:00.000Z' };
	const localFile = { path: 'notes/a.md', extension: 'md', stat: { size: 1, mtime: 1700000000000 } };

	function emptyVault(harness: ReturnType<typeof createHarness>) {
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
	}
	function vaultWithLocalFile(harness: ReturnType<typeof createHarness>) {
		harness.vault.getFiles.mockReturnValue([localFile]);
		harness.vault.getAbstractFileByPath.mockReturnValue(localFile);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('A'));
	}
	function rejectDownloads(harness: ReturnType<typeof createHarness>) {
		harness.api.batchDownload.mockRejectedValue(unauthorized());
		harness.api.downloadFile.mockRejectedValue(unauthorized());
	}
	function rejectUploads(harness: ReturnType<typeof createHarness>) {
		harness.api.batchUpload.mockResolvedValue({
			success: false,
			results: [{ path: localFile.path, success: false, status: 401, error: 'Unauthorized' }],
		});
	}
	function expectReconnect(harness: ReturnType<typeof createHarness>, result: SyncResult, lastSeq: number) {
		expect(result).toMatchObject({ success: false });
		expect(result.errors).toContain(AUTH_ERROR_MESSAGE);
		expect(harness.engine.getState()).toMatchObject({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
		expect(Notice.messages).toEqual([AUTH_ERROR_MESSAGE]);
		expect(harness.settings).toMatchObject({ lastSync: null, lastSeq });
		harness.engine.destroy();
	}

	beforeEach(() => Notice.reset());

	it('reports a download in a full sync with the reconnect message', async () => {
		const harness = createHarness({ lastSeq: 0 });
		harness.api.getManifest.mockResolvedValue({ version: 1, files: { 'notes/remote.md': { hash: 'remote-hash', size: 10, modified: '2026-02-06T12:00:00.000Z' } }, lastSeq: 3 });
		emptyVault(harness);
		rejectDownloads(harness);
		expectReconnect(harness, await harness.engine.sync(), 0);
	});

	it('reports a download in an incremental sync with the reconnect message', async () => {
		const harness = createHarness({ lastSeq: 1 });
		harness.api.getChanges.mockResolvedValue({ changes: [remoteChange], lastSeq: 2, hasMore: false });
		emptyVault(harness);
		rejectDownloads(harness);
		expectReconnect(harness, await harness.engine.sync(), 1);
	});

	it('reports an upload in an incremental sync with the reconnect message', async () => {
		const harness = createHarness({ lastSeq: 1 });
		harness.api.getChanges.mockResolvedValue({ changes: [], lastSeq: 1, hasMore: false });
		vaultWithLocalFile(harness);
		rejectUploads(harness);
		const result = await harness.engine.sync();
		expect(harness.api.batchUpload).toHaveBeenCalledOnce();
		expect(harness.api.getManifest).not.toHaveBeenCalled();
		expectReconnect(harness, result, 1);
	});

	it('reports a conflicting upload whose reconciliation is rejected with the reconnect message', async () => {
		const harness = createHarness({ lastSeq: 1 });
		harness.api.getChanges.mockResolvedValue({ changes: [], lastSeq: 1, hasMore: false });
		vaultWithLocalFile(harness);
		harness.api.batchUpload.mockResolvedValue({
			success: false,
			results: [{ path: localFile.path, success: false, status: 409, code: 'version_conflict', error: 'Remote file changed' }],
		});
		const getFileMetadata = vi.fn().mockRejectedValue(unauthorized());
		Object.assign(harness.api, { getFileMetadata });
		const result = await harness.engine.sync();
		expect(getFileMetadata).toHaveBeenCalledOnce();
		expectReconnect(harness, result, 1);
	});

	it('reports an upload in a force full sync with the reconnect message', async () => {
		const harness = createHarness({ lastSeq: 1 });
		harness.api.getManifest.mockResolvedValue({ version: 1, files: {}, lastSeq: 1 });
		vaultWithLocalFile(harness);
		rejectUploads(harness);
		expectReconnect(harness, await harness.engine.forceFullSync(), 1);
	});
});
