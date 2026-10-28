import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadAndSaveFile } from './download';
import { parallelDownloadAndSaveFiles } from './download';
import { processDiff } from './process';
import { createNamedAbortError, createTransferHarness, emptyResult } from './transfer-test-harness';
import { sha256Hex } from '../../platform/sha256';
import { Platform } from 'obsidian';
import { runConcurrentTasks } from '../concurrency';
import { HttpError, SyncTransportError } from '../worker-api/http';
import { BATCH_FILE_SIZE_LIMIT } from '../../protocol/sync-limits';

const conflictMocks = vi.hoisted(() => ({
	createConflictCopy: vi.fn(async () => 'notes/file (conflict).md'),
}));

vi.mock('../conflict/conflict', () => ({
	createConflictCopy: conflictMocks.createConflictCopy,
}));

describe('transfer download/process helpers', () => {
	beforeEach(() => {
		conflictMocks.createConflictCopy.mockClear();
	});

	it('saves downloaded content and records manifest entry', async () => {
		const harness = createTransferHarness();
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		const content = new TextEncoder().encode('hello').buffer;

		harness.vault.createBinary.mockImplementation(async () => { harness.adapter.readBinary.mockResolvedValue(content); });
		const hash = await sha256Hex(content);
		harness.api.downloadFile.mockResolvedValue({ content, size: 5, hash, revision: 'revision-1' });
		await downloadAndSaveFile(harness.context, { path: 'notes/a.md', expectedLocalHash: null, expectedRemoteHash: hash, remoteSize: 5 }, emptyResult());

		expect(harness.vault.createFolder).toHaveBeenCalledWith('notes');
		expect(harness.vault.createBinary).toHaveBeenCalledWith('notes/a.md', content);
		expect(harness.localManifest.setEntry).toHaveBeenCalledWith(
			'notes/a.md',
			expect.objectContaining({ size: 5, modified: '2026-02-15T00:00:00.000Z' }),
		);
	});

	it('processes conflict diffs by writing conflict copy and remote replacement', async () => {
		const harness = createTransferHarness();
		const local = new TextEncoder().encode('local').buffer;
		const remote = new TextEncoder().encode('remote').buffer;
		harness.vault.getAbstractFileByPath.mockReturnValue({ path: 'notes/a.md', extension: 'md' });
		harness.adapter.readBinary.mockResolvedValue(local);
		harness.api.downloadFile.mockResolvedValue({
			content: remote,
			contentType: 'text/markdown',
			size: remote.byteLength,
		});

		const result = emptyResult();
		const localFiles: Record<string, { hash: string; size: number; modified: string }> = {};

		await processDiff(
			harness.context,
			{ path: 'notes/a.md', action: 'conflict', localHash: 'l', remoteHash: await sha256Hex(remote), cause: 'concurrent-edit' },
			localFiles,
			result,
		);

		expect(conflictMocks.createConflictCopy).toHaveBeenCalled();
		expect(harness.vault.modifyBinary).toHaveBeenCalledWith({ path: 'notes/a.md', extension: 'md' }, remote);
		expect(result.conflicts).toEqual(['notes/file (conflict).md']);
		expect(localFiles['notes/a.md']?.size).toBe(remote.byteLength);
		expect(harness.localManifest.setEntry).toHaveBeenCalledWith(
			'notes/a.md',
			expect.objectContaining({ size: remote.byteLength }),
		);
	});

	it('uploads planned full-sync diffs even when the local manifest hash already matches', async () => {
		const harness = createTransferHarness();
		const content = new TextEncoder().encode('local').buffer;
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 5, mtime: 1700000000000 },
		});
		harness.adapter.readBinary.mockResolvedValue(content);
		harness.adapter.stat.mockResolvedValue({ type: 'file', size: 5, mtime: 1700000000000 });
		harness.localManifest.hashMatches.mockReturnValue(true);
		harness.api.uploadFile.mockResolvedValue({
			success: true,
			path: 'notes/a.md',
			hash: await sha256Hex(content),
		});

		const result = emptyResult();
		const localFiles: Record<string, { hash: string; size: number; modified: string }> = {};

		await processDiff(
			harness.context,
			{ path: 'notes/a.md', action: 'upload', localHash: 'l', cause: 'local-created' },
			localFiles,
			result,
		);

		expect(harness.api.uploadFile).toHaveBeenCalledWith(
			'notes/a.md',
			content,
			expect.any(String),
			5,
			'text/markdown',
			null,
		);
		expect(result.uploaded).toBe(1);
		expect(result.uploadedPaths).toEqual(['notes/a.md']);
	});

	it('flags a successful upload that resolves a concurrent remote delete', async () => {
		const harness = createTransferHarness();
		const content = new TextEncoder().encode('local edit').buffer;
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: content.byteLength, mtime: 1700000000000 },
		});
		harness.adapter.readBinary.mockResolvedValue(content);
		harness.adapter.stat.mockResolvedValue({ type: 'file', size: content.byteLength, mtime: 1700000000000 });
		harness.api.uploadFile.mockResolvedValue({
			success: true,
			path: 'notes/a.md',
			hash: await sha256Hex(content),
		});
		const result = emptyResult();

		await processDiff(
			harness.context,
			{ path: 'notes/a.md', action: 'upload', localHash: 'local', cause: 'remote-deleted' },
			{},
			result,
		);

		expect(harness.api.uploadFile).toHaveBeenCalledWith(
			'notes/a.md',
			content,
			expect.any(String),
			content.byteLength,
			'text/markdown',
			null,
		);
		expect(result.conflicts).toEqual([]);
		expect(result.resolvedRaces).toEqual([{ path: 'notes/a.md', resolution: 'kept-local-edit' }]);
	});

	it('moves a local file to trash when the remote delete wins', async () => {
		const harness = createTransferHarness();
		const content = new TextEncoder().encode('base').buffer;
		const hash = await sha256Hex(content);
		const file = { path: 'notes/a.md', extension: 'md' };
		harness.vault.getAbstractFileByPath.mockReturnValue(file);
		harness.adapter.readBinary.mockResolvedValue(content);
		const result = emptyResult();
		const localFiles = {
			'notes/a.md': { hash: 'base', size: 4, modified: '2026-02-15T00:00:00.000Z' },
		};

		await processDiff(
			harness.context,
			{ path: 'notes/a.md', action: 'delete-local', localHash: hash, cause: 'remote-deleted' },
			localFiles,
			result,
		);

		expect(harness.vault.trash).toHaveBeenCalledWith(file, false);
		expect(harness.localManifest.removeEntry).toHaveBeenCalledWith('notes/a.md');
		expect(result.deletedPaths).toEqual(['notes/a.md']);
		expect(localFiles).not.toHaveProperty('notes/a.md');
	});

	it('uploads a local edit made after a full-sync remote delete was planned', async () => {
		const harness = createTransferHarness();
		const baseContent = new TextEncoder().encode('base').buffer;
		const changedContent = new TextEncoder().encode('edited during sync').buffer;
		const baseHash = await sha256Hex(baseContent);
		const changedHash = await sha256Hex(changedContent);
		const file = {
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: changedContent.byteLength, mtime: 1700000000000 },
		};
		harness.vault.getAbstractFileByPath.mockReturnValue(file);
		harness.adapter.readBinary.mockResolvedValue(changedContent);
		harness.adapter.stat.mockResolvedValue({ type: 'file', size: changedContent.byteLength, mtime: 1700000000000 });
		harness.api.uploadFile.mockResolvedValue({
			success: true,
			path: 'notes/a.md',
			hash: changedHash,
		});
		const result = emptyResult();
		const localFiles = {
			'notes/a.md': { hash: baseHash, size: baseContent.byteLength, modified: '2026-02-15T00:00:00.000Z' },
		};

		await processDiff(
			harness.context,
			{ path: 'notes/a.md', action: 'delete-local', localHash: baseHash, cause: 'remote-deleted' },
			localFiles,
			result,
		);

		expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
		expect(harness.api.uploadFile).toHaveBeenCalledWith(
			'notes/a.md',
			changedContent,
			changedHash,
			changedContent.byteLength,
			'text/markdown',
			null,
		);
		expect(result.uploadedPaths).toEqual(['notes/a.md']);
		expect(result.conflicts).toEqual([]);
		expect(result.resolvedRaces).toEqual([{ path: 'notes/a.md', resolution: 'kept-local-edit' }]);
		expect(localFiles['notes/a.md']?.hash).toBe(changedHash);
	});

	it('trusts the hash decryption verified instead of rehashing batch plaintext', async () => {
		const harness = createTransferHarness();
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		const content = new TextEncoder().encode('ok').buffer;
		// A deliberately different hash proves the transfer did not hash the bytes again.
		const verifiedHash = 'a'.repeat(64);
		harness.api.batchDownload.mockResolvedValue({ files: [{ path: 'good.md', verifiedContent: content, hash: verifiedHash, size: 2, contentType: 'text/plain' }] });
		const result = emptyResult();
		await parallelDownloadAndSaveFiles(harness.context, [{ path: 'good.md', expectedLocalHash: null, expectedRemoteHash: verifiedHash, remoteSize: 2 }], result, 5);
		expect(result.errors).toEqual([]);
		expect(result.downloaded).toBe(1);
	});

	it('aggregates per-path download errors during batch downloads', async () => {
		const harness = createTransferHarness();
		harness.vault.getAbstractFileByPath.mockReturnValue(null);

		const okContent = new TextEncoder().encode('ok');
		const b64 = btoa(String.fromCharCode(...okContent));

		harness.api.batchDownload.mockResolvedValue({
			files: [
				{ path: 'good.md', content: b64, hash: await sha256Hex(okContent.buffer), size: 2, contentType: 'text/plain' },
				{ path: 'bad.md', content: '', hash: '', size: 0, contentType: '', error: 'File not found' },
			],
		});

		const result = emptyResult();
		await parallelDownloadAndSaveFiles(harness.context, [{ path: 'good.md', expectedLocalHash: null, expectedRemoteHash: await sha256Hex(okContent.buffer), remoteSize: 2 }, { path: 'bad.md', expectedLocalHash: null, expectedRemoteHash: 'missing', remoteSize: 2 }], result, 5);

		expect(result.downloaded).toBe(1);
		expect(result.errors).toContain('bad.md: File not found');
	});

	it('defers a remote download when the local file changed after planning', async () => {
		const harness = createTransferHarness();
		const plannedLocal = new TextEncoder().encode('planned local').buffer;
		const changedLocal = new TextEncoder().encode('changed during sync').buffer;
		const remote = new TextEncoder().encode('remote').buffer;
		const path = 'notes/race.md';
		harness.vault.getAbstractFileByPath.mockReturnValue({ path, extension: 'md' });
		harness.adapter.readBinary.mockResolvedValue(changedLocal);
		harness.api.batchDownload.mockResolvedValue({
			files: [{
				path,
				content: btoa(String.fromCharCode(...new Uint8Array(remote))),
				hash: await sha256Hex(remote),
				size: remote.byteLength,
				contentType: 'text/markdown',
			}],
		});

		const result = emptyResult();
		await parallelDownloadAndSaveFiles(harness.context, [{
			path,
			expectedLocalHash: await sha256Hex(plannedLocal),
			expectedRemoteHash: await sha256Hex(remote),
			remoteSize: remote.byteLength,
		}], result, 5);

		expect(conflictMocks.createConflictCopy).not.toHaveBeenCalled();
		expect(result.conflicts).toEqual([]);
		expect(result.downloaded).toBe(0);
		expect(result.errors).toContain(`${path}: Local file changed while the remote version was downloading`);
		expect(harness.vault.modifyBinary).not.toHaveBeenCalled();
	});

	it('returns a deferred outcome when a locally deleted path is recreated during download', async () => {
		const harness = createTransferHarness();
		const lateLocal = new TextEncoder().encode('created during sync').buffer;
		const remote = new TextEncoder().encode('remote edit').buffer;
		const path = 'notes/race.md';
		harness.vault.getAbstractFileByPath.mockReturnValue({ path, extension: 'md' });
		harness.adapter.readBinary
			.mockResolvedValueOnce(lateLocal)
			.mockResolvedValueOnce(remote);
		harness.api.downloadFile.mockResolvedValue({
			content: remote,
			contentType: 'text/markdown',
			hash: await sha256Hex(remote),
			size: remote.byteLength,
		});
		const result = emptyResult();

		const outcome = await processDiff(
			harness.context,
			{
				path,
				action: 'download',
				remoteHash: await sha256Hex(remote),
				cause: 'local-deleted',
			},
			{},
			result,
		);

		expect(outcome).toEqual({
			status: 'deferred',
			reason: 'Local file changed while the remote version was downloading',
		});
		expect(result.unresolvedConflicts).toEqual([]);
		expect(result.resolvedRaces).toEqual([]);
		expect(harness.vault.modifyBinary).not.toHaveBeenCalled();
	});

	it('falls back to individual downloads when batch fails', async () => {
		const harness = createTransferHarness();
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.api.batchDownload.mockRejectedValue(new Error('batch endpoint not available'));
		harness.api.downloadFile.mockResolvedValue({
			content: new TextEncoder().encode('ok').buffer,
			contentType: 'text/plain',
			size: 2,
		});

		const result = emptyResult();
		await parallelDownloadAndSaveFiles(harness.context, [{ path: 'fallback.md', expectedLocalHash: null, expectedRemoteHash: await sha256Hex(new TextEncoder().encode('ok').buffer), remoteSize: 2 }], result, 5);

		expect(harness.api.downloadFile).toHaveBeenCalledWith('fallback.md');
		expect(result.downloaded).toBe(1);
	});

	it('propagates non-DOM AbortError batch download failures without fallback', async () => {
		const harness = createTransferHarness();
		harness.api.batchDownload.mockRejectedValue(createNamedAbortError());

		const result = emptyResult();
		await expect(
			parallelDownloadAndSaveFiles(harness.context, [{ path: 'aborted.md', expectedLocalHash: null, expectedRemoteHash: 'remote', remoteSize: 2 }], result, 5),
		).rejects.toMatchObject({ name: 'AbortError' });

		expect(harness.api.downloadFile).not.toHaveBeenCalled();
		expect(result.errors).toEqual([]);
	});

	it('propagates individual download cancellation without recording a file error', async () => {
		const harness = createTransferHarness();
		harness.api.batchDownload.mockRejectedValue(new Error('Batch unavailable'));
		harness.api.downloadFile.mockRejectedValue(createNamedAbortError());
		const result = emptyResult();
		await expect(parallelDownloadAndSaveFiles(harness.context,
			[{ path: 'aborted.md', expectedLocalHash: null, expectedRemoteHash: 'remote', remoteSize: 2 }], result, 5))
			.rejects.toMatchObject({ name: 'AbortError' });
		expect(result.errors).toEqual([]);
	});
});

it('reports every file across concurrent download batches', async () => {
	const harness = createTransferHarness();
	harness.vault.getAbstractFileByPath.mockReturnValue(null);
	const content = new TextEncoder().encode('ok');
	const hash = await sha256Hex(content.buffer);
	const onProcessed = vi.fn();
	harness.api.batchDownload.mockImplementation(async (paths: string[]) => {
		return { files: paths.map(path => ({ path, content: btoa('ok'), hash, size: 2, contentType: 'text/plain' })) };
	});
	const requests = Array.from({ length: 51 }, (_, index) => ({
		path: `file-${index}.md`, expectedLocalHash: null, expectedRemoteHash: hash, remoteSize: 2,
	}));
	const result = emptyResult();
	await parallelDownloadAndSaveFiles(harness.context, requests, result, 2, onProcessed);
	expect(result.downloaded).toBe(51);
	expect(onProcessed).toHaveBeenCalledTimes(51);
});

const runConcurrent = <T>(tasks: Array<() => Promise<T>>, concurrency: number) => runConcurrentTasks(tasks, concurrency, () => false);

it.each([
	['a timeout', () => new SyncTransportError('Request timed out after 120000ms')],
	['revoked access', () => new HttpError('Unauthorized', 401)],
	['rate limiting', () => new HttpError('Too many requests', 429, 30_000)],
])('fails the remaining downloads without sending them after a batch fails with %s', async (_name, error) => {
	const harness = createTransferHarness();
	harness.api.batchDownload.mockRejectedValue(error());
	const onProcessed = vi.fn();
	const onFailure = vi.fn();
	const requests = [
		...Array.from({ length: 250 }, (_, index) => ({ path: `notes/${index}.md`, expectedLocalHash: null, expectedRemoteHash: 'a'.repeat(64), remoteSize: 10 })),
		{ path: 'large.bin', expectedLocalHash: null, expectedRemoteHash: 'b'.repeat(64), remoteSize: BATCH_FILE_SIZE_LIMIT },
	];
	const result = emptyResult();
	await parallelDownloadAndSaveFiles({ ...harness.context, runConcurrent }, requests, result, 2, onProcessed, onFailure);
	// Only the two batches already in flight were sent.
	expect(harness.api.batchDownload).toHaveBeenCalledTimes(2);
	expect(harness.api.downloadFile).not.toHaveBeenCalled();
	expect(result.errors).toHaveLength(251);
	expect(onProcessed).toHaveBeenCalledTimes(251);
	expect(onFailure).toHaveBeenCalledTimes(251);
	const thrown = error();
	if (thrown instanceof HttpError) expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ path: 'large.bin', status: thrown.status }));
});

it('still downloads each file when a batch response does not match its request', async () => {
	const harness = createTransferHarness();
	harness.vault.getAbstractFileByPath.mockReturnValue(null);
	const content = new TextEncoder().encode('ok').buffer;
	harness.api.batchDownload.mockResolvedValue({ files: [] });
	harness.api.downloadFile.mockResolvedValue({ content, contentType: 'text/plain', size: 2 });
	const result = emptyResult();
	await parallelDownloadAndSaveFiles({ ...harness.context, runConcurrent }, [{ path: 'fallback.md', expectedLocalHash: null, expectedRemoteHash: await sha256Hex(content), remoteSize: 2 }], result, 2);
	expect(harness.api.downloadFile).toHaveBeenCalledWith('fallback.md');
	expect(result.downloaded).toBe(1);
});

it.each(['isWin', 'isAndroidApp'] as const)('skips a remote file whose name this device cannot store: %s', async platform => {
	const previous = { isWin: Platform.isWin, isAndroidApp: Platform.isAndroidApp };
	Object.assign(Platform, { [platform]: true });
	try {
		const harness = createTransferHarness();
		const onProcessed = vi.fn();
		const result = emptyResult();
		await parallelDownloadAndSaveFiles(harness.context, [{ path: 'notes/a:b.md', expectedLocalHash: null, expectedRemoteHash: 'a'.repeat(64), remoteSize: 2 }], result, 2, onProcessed);
		expect(harness.api.batchDownload).not.toHaveBeenCalled();
		expect(harness.adapter.exists).not.toHaveBeenCalled();
		expect(result.errors).toEqual([]);
		expect(result.issues).toEqual([expect.objectContaining({ path: 'notes/a:b.md', code: 'unsupported-device-path' })]);
		expect(onProcessed).toHaveBeenCalledOnce();
	} finally { Object.assign(Platform, previous); }
});
