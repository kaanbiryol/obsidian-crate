import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeHash } from './hasher';
import { parallelDownloadAndSaveFiles, processDiff, saveDownloadedContent } from './transfer';
import { createNamedAbortError, createTransferHarness, emptyResult } from './transfer-test-harness';

const conflictMocks = vi.hoisted(() => ({
	createConflictCopy: vi.fn(async () => 'notes/file (conflict).md'),
}));

vi.mock('./conflict', () => ({
	createConflictCopy: conflictMocks.createConflictCopy,
}));

describe('transfer download/process helpers', () => {
	beforeEach(() => {
		conflictMocks.createConflictCopy.mockClear();
	});

	it('saves downloaded content and records manifest entry', async () => {
		const harness = createTransferHarness();
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		const content = new TextEncoder().encode('hello').buffer as ArrayBuffer;

		await saveDownloadedContent(harness.context, 'notes/a.md', content);

		expect(harness.vault.createFolder).toHaveBeenCalledWith('notes');
		expect(harness.vault.createBinary).toHaveBeenCalledWith('notes/a.md', content);
		expect(harness.localManifest.setEntry).toHaveBeenCalledWith(
			'notes/a.md',
			expect.objectContaining({ size: 5, modified: '2026-02-15T00:00:00.000Z' }),
		);
	});

	it('processes conflict diffs by writing conflict copy and remote replacement', async () => {
		const harness = createTransferHarness();
		const local = new TextEncoder().encode('local').buffer as ArrayBuffer;
		const remote = new TextEncoder().encode('remote').buffer as ArrayBuffer;
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
			{ path: 'notes/a.md', action: 'conflict', localHash: 'l', remoteHash: await computeHash(remote), cause: 'concurrent-edit' },
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
		const content = new TextEncoder().encode('local').buffer as ArrayBuffer;
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
			hash: await computeHash(content),
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
		const content = new TextEncoder().encode('local edit').buffer as ArrayBuffer;
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
			hash: await computeHash(content),
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
		const content = new TextEncoder().encode('base').buffer as ArrayBuffer;
		const hash = await computeHash(content);
		const file = { path: 'notes/a.md' };
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

		expect(harness.fileManager.trashFile).toHaveBeenCalledWith(file);
		expect(harness.localManifest.removeEntry).toHaveBeenCalledWith('notes/a.md');
		expect(result.deletedPaths).toEqual(['notes/a.md']);
		expect(localFiles).not.toHaveProperty('notes/a.md');
	});

	it('uploads a local edit made after a full-sync remote delete was planned', async () => {
		const harness = createTransferHarness();
		const baseContent = new TextEncoder().encode('base').buffer as ArrayBuffer;
		const changedContent = new TextEncoder().encode('edited during sync').buffer as ArrayBuffer;
		const baseHash = await computeHash(baseContent);
		const changedHash = await computeHash(changedContent);
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

	it('aggregates per-path download errors during batch downloads', async () => {
		const harness = createTransferHarness();
		harness.vault.getAbstractFileByPath.mockReturnValue(null);

		const okContent = new TextEncoder().encode('ok');
		const b64 = btoa(String.fromCharCode(...okContent));

		harness.api.batchDownload.mockResolvedValue({
			files: [
				{ path: 'good.md', content: b64, hash: await computeHash(okContent.buffer), size: 2, contentType: 'text/plain' },
				{ path: 'bad.md', content: '', hash: '', size: 0, contentType: '', error: 'File not found' },
			],
		});

		const result = emptyResult();
		await parallelDownloadAndSaveFiles(harness.context, ['good.md', 'bad.md'], result, 5);

		expect(result.downloaded).toBe(1);
		expect(result.errors).toContain('bad.md: File not found');
	});

	it('defers a remote download when the local file changed after planning', async () => {
		const harness = createTransferHarness();
		const plannedLocal = new TextEncoder().encode('planned local').buffer as ArrayBuffer;
		const changedLocal = new TextEncoder().encode('changed during sync').buffer as ArrayBuffer;
		const remote = new TextEncoder().encode('remote').buffer as ArrayBuffer;
		const path = 'notes/race.md';
		harness.vault.getAbstractFileByPath.mockReturnValue({ path, extension: 'md' });
		harness.adapter.readBinary.mockResolvedValue(changedLocal);
		harness.api.batchDownload.mockResolvedValue({
			files: [{
				path,
				content: btoa(String.fromCharCode(...new Uint8Array(remote))),
				hash: await computeHash(remote),
				size: remote.byteLength,
				contentType: 'text/markdown',
			}],
		});

		const result = emptyResult();
		await parallelDownloadAndSaveFiles(harness.context, [{
			path,
			expectedLocalHash: await computeHash(plannedLocal),
			expectedRemoteHash: await computeHash(remote),
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
		const lateLocal = new TextEncoder().encode('created during sync').buffer as ArrayBuffer;
		const remote = new TextEncoder().encode('remote edit').buffer as ArrayBuffer;
		const path = 'notes/race.md';
		harness.vault.getAbstractFileByPath.mockReturnValue({ path, extension: 'md' });
		harness.adapter.readBinary
			.mockResolvedValueOnce(lateLocal)
			.mockResolvedValueOnce(remote);
		harness.api.downloadFile.mockResolvedValue({
			content: remote,
			contentType: 'text/markdown',
			hash: await computeHash(remote),
			size: remote.byteLength,
		});
		const result = emptyResult();

		const outcome = await processDiff(
			harness.context,
			{
				path,
				action: 'download',
				remoteHash: await computeHash(remote),
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
			content: new TextEncoder().encode('ok').buffer as ArrayBuffer,
			contentType: 'text/plain',
			size: 2,
		});

		const result = emptyResult();
		await parallelDownloadAndSaveFiles(harness.context, ['fallback.md'], result, 5);

		expect(harness.api.downloadFile).toHaveBeenCalledWith('fallback.md');
		expect(result.downloaded).toBe(1);
	});

	it('propagates non-DOM AbortError batch download failures without fallback', async () => {
		const harness = createTransferHarness();
		harness.api.batchDownload.mockRejectedValue(createNamedAbortError());

		const result = emptyResult();
		await expect(
			parallelDownloadAndSaveFiles(harness.context, ['aborted.md'], result, 5),
		).rejects.toMatchObject({ name: 'AbortError' });

		expect(harness.api.downloadFile).not.toHaveBeenCalled();
		expect(result.errors).toEqual([]);
	});
});
