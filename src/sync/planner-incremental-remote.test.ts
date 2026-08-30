import { describe, expect, it, vi } from 'vitest';
import { computeHash } from './hasher';
import type { PreparedUpload, SyncResult } from '../plugin/types';
import { runIncrementalSync } from './planner';
import { createIncrementalHarness, createSettings } from './planner-test-harness';

const fileDiscoveryMocks = vi.hoisted(() => ({
	getAllVaultFiles: vi.fn(),
	isHiddenPath: vi.fn((path: string) => path.split('/').some(segment => segment.startsWith('.'))),
}));

const conflictMocks = vi.hoisted(() => ({
	createConflictCopy: vi.fn(async () => 'notes/file (conflict).md'),
	detectConflicts: vi.fn(),
}));

vi.mock('./file-discovery', () => ({
	getAllVaultFiles: fileDiscoveryMocks.getAllVaultFiles,
	isHiddenPath: fileDiscoveryMocks.isHiddenPath,
}));

vi.mock('./conflict', () => ({
	createConflictCopy: conflictMocks.createConflictCopy,
}));

vi.mock('./reconciliation', () => ({
	detectConflicts: conflictMocks.detectConflicts,
}));

describe('runIncrementalSync', () => {
it('returns fast success and advances cursor when nothing changed', async () => {
		const settings = createSettings({ lastSeq: 5 });
		const localManifest = {
			save: vi.fn(async () => {}),
			setEntry: vi.fn(),
			removeEntry: vi.fn(),
			getEntry: vi.fn((path: string) => path === 'notes/local-delete.md'
				? { hash: 'a'.repeat(64), size: 1, modified: '2026-02-15T00:00:00.000Z' }
				: undefined),
			getAllPaths: vi.fn(() => []),
			getManifest: vi.fn(() => ({ version: 1, files: {} })),
		};
		const context = {
			settings,
			vault: {
				getAbstractFileByPath: vi.fn(),
				delete: vi.fn(),
				adapter: {
					exists: vi.fn(),
					remove: vi.fn(),
					stat: vi.fn(),
					readBinary: vi.fn(),
				},
			} as never,
			api: {
				getChanges: vi.fn(async () => ({ changes: [], lastSeq: 8, hasMore: false })),
				downloadFile: vi.fn(),
				deleteFile: vi.fn(),
				batchDelete: vi.fn(async (paths: string[]) => ({ success: true, deleted: paths })),
			},
			localManifest,
			shouldIgnore: vi.fn(() => false),
			getLocalChanges: vi.fn(async () => []),
			getLocalDeletes: vi.fn(async () => []),
			parallelDownloadAndSaveFiles: vi.fn(async () => {}),
			processDiff: vi.fn(async () => {}),
			prepareUploadFromPath: vi.fn(async () => null),
			uploadPreparedFiles: vi.fn(async () => {}),
		};

		const result = await runIncrementalSync(context, { uploadConcurrency: 5 });

		expect(result).toEqual({
			success: true,
			uploaded: 0,
			downloaded: 0,
			merged: 0,
			deleted: 0,
			conflicts: [],
			errors: [],
			uploadedPaths: [],
			downloadedPaths: [],
			mergedPaths: [],
			deletedPaths: [],
		});
		expect(settings.lastSeq).toBe(8);
		expect(localManifest.save).not.toHaveBeenCalled();
	});

	it('applies remote delete changes through the file manager', async () => {
		const content = new TextEncoder().encode('remote delete base').buffer as ArrayBuffer;
		const hash = await computeHash(content);
		const harness = createIncrementalHarness({
			settings: { lastSeq: 4 },
			changes: [
				{
					seq: 6,
					path: 'notes/old.md',
					action: 'delete',
					hash: '',
					size: 0,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 6,
		});
		const note = { path: 'notes/old.md' };
		harness.vault.getAbstractFileByPath.mockReturnValue(note);
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		harness.localManifest.getEntry.mockReturnValue({
			hash,
			size: content.byteLength,
			modified: '2026-02-06T12:00:00.000Z',
		});

		const result = await runIncrementalSync(harness.context, { uploadConcurrency: 5 });

		expect(result?.deleted).toBe(1);
		expect(harness.fileManager.trashFile).toHaveBeenCalledWith(note);
		expect(harness.vault.delete).not.toHaveBeenCalled();
		expect(harness.vault.adapter.remove).not.toHaveBeenCalled();
		expect(harness.localManifest.removeEntry).toHaveBeenCalledWith('notes/old.md');
		expect(harness.settings.lastSeq).toBe(6);
	});

	it('hard deletes hidden files for remote delete changes', async () => {
		const content = new TextEncoder().encode('hidden base').buffer as ArrayBuffer;
		const hash = await computeHash(content);
		const harness = createIncrementalHarness({
			settings: { lastSeq: 4 },
			changes: [
				{
					seq: 6,
					path: '.vault-config/workspace.json',
					action: 'delete',
					hash: '',
					size: 0,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 6,
		});
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.vault.adapter.exists.mockResolvedValue(true);
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		harness.localManifest.getEntry.mockReturnValue({
			hash,
			size: content.byteLength,
			modified: '2026-02-06T12:00:00.000Z',
		});

		const result = await runIncrementalSync(harness.context, { uploadConcurrency: 5 });

		expect(result?.deleted).toBe(1);
		expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
		expect(harness.vault.delete).not.toHaveBeenCalled();
		expect(harness.vault.adapter.remove).toHaveBeenCalledWith('.vault-config/workspace.json');
		expect(harness.localManifest.removeEntry).toHaveBeenCalledWith('.vault-config/workspace.json');
		expect(harness.settings.lastSeq).toBe(6);
	});

	it.each([
		{ path: 'notes/edited-during-sync.md', hidden: false },
		{ path: '.vault-config/edited-during-sync.json', hidden: true },
	])('preserves a newer local edit before applying a remote delete ($path)', async ({ path, hidden }) => {
		const baseContent = new TextEncoder().encode('planned content').buffer as ArrayBuffer;
		const changedContent = new TextEncoder().encode('edited during sync').buffer as ArrayBuffer;
		const baseHash = await computeHash(baseContent);
		const changedHash = await computeHash(changedContent);
		const prepared: PreparedUpload = {
			path,
			content: changedContent,
			hash: changedHash,
			size: changedContent.byteLength,
			contentType: hidden ? 'application/json' : 'text/markdown',
		};
		const harness = createIncrementalHarness({
			settings: { lastSeq: 4 },
			changes: [{
				seq: 6,
				path,
				action: 'delete',
				hash: '',
				size: 0,
				created_at: '2026-02-06T12:00:00.000Z',
			}],
			lastSeq: 6,
		});
		harness.vault.getAbstractFileByPath.mockReturnValue(hidden ? null : { path });
		harness.vault.adapter.exists.mockResolvedValue(hidden);
		harness.vault.adapter.readBinary.mockResolvedValue(changedContent);
		harness.localManifest.getEntry.mockReturnValue({
			hash: baseHash,
			size: baseContent.byteLength,
			modified: '2026-02-06T12:00:00.000Z',
		});
		harness.context.prepareUploadFromPath = vi.fn(async () => prepared);
		harness.context.uploadPreparedFiles = vi.fn(async (uploads: PreparedUpload[], result: SyncResult) => {
			result.uploaded += uploads.length;
			result.uploadedPaths.push(...uploads.map(upload => upload.path));
		});

		const result = await runIncrementalSync(harness.context, { uploadConcurrency: 5 });

		expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
		expect(harness.vault.adapter.remove).not.toHaveBeenCalled();
		expect(prepared.expectedHash).toBeNull();
		expect(result?.uploadedPaths).toContain(path);
		expect(result?.conflicts).toContain(path);
	});

	it('cleans manifest state when a remote delete targets an already missing file', async () => {
		const harness = createIncrementalHarness({
			settings: { lastSeq: 4 },
			changes: [
				{
					seq: 6,
					path: 'notes/missing.md',
					action: 'delete',
					hash: '',
					size: 0,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 6,
		});
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.vault.adapter.exists.mockResolvedValue(false);

		const result = await runIncrementalSync(harness.context, { uploadConcurrency: 5 });

		expect(result?.deleted).toBe(0);
		expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
		expect(harness.vault.delete).not.toHaveBeenCalled();
		expect(harness.vault.adapter.remove).not.toHaveBeenCalled();
		expect(harness.localManifest.removeEntry).toHaveBeenCalledWith('notes/missing.md');
		expect(harness.settings.lastSeq).toBe(6);
	});

	it('skips download when remote put hash matches local content', async () => {
		const content = new TextEncoder().encode('same').buffer as ArrayBuffer;
		const hash = await computeHash(content);
		const harness = createIncrementalHarness({
			settings: { lastSeq: 2 },
			changes: [
				{
					seq: 3,
					path: 'notes/same.md',
					action: 'put',
					hash,
					size: 4,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 3,
		});
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/same.md',
			extension: 'md',
			stat: { size: 4, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);

		const result = await runIncrementalSync(harness.context, { uploadConcurrency: 5 });

		expect(result?.downloaded).toBe(0);
		expect(harness.api.downloadFile).not.toHaveBeenCalled();
		expect(harness.localManifest.setEntry).toHaveBeenCalledWith(
			'notes/same.md',
			expect.objectContaining({
				hash,
				size: 4,
			}),
		);
	});

	it('uploads local-only changes not present in the remote changelog', async () => {
		const prepared: PreparedUpload = {
			path: 'notes/new.md',
			content: new TextEncoder().encode('hello world').buffer as ArrayBuffer,
			hash: 'local-hash',
			size: 11,
			contentType: 'text/markdown',
		};
		const harness = createIncrementalHarness({
			settings: { lastSeq: 7 },
			localChanges: [{ path: 'notes/new.md', hash: 'local-hash' }],
			lastSeq: 9,
		});
		const uploadPreparedFiles = vi.fn(async (uploads: PreparedUpload[], result: SyncResult) => {
			result.uploaded += uploads.length;
			result.uploadedPaths.push(...uploads.map(upload => upload.path));
		});
		harness.context.prepareUploadFromPath = vi.fn(async () => prepared);
		harness.context.uploadPreparedFiles = uploadPreparedFiles;

		const result = await runIncrementalSync(harness.context, { uploadConcurrency: 5 });

		expect(uploadPreparedFiles).toHaveBeenCalledWith(
			[prepared],
			expect.any(Object),
			expect.objectContaining({ concurrency: 5, retry: true }),
		);
		expect(result?.uploaded).toBe(1);
		expect(harness.settings.lastSeq).toBe(9);
	});

	it('keeps local edits when a remote delete arrives and re-uploads the path', async () => {
		const prepared: PreparedUpload = {
			path: 'notes/live.md',
			content: new TextEncoder().encode('keep local').buffer as ArrayBuffer,
			hash: 'local-hash',
			size: 10,
			contentType: 'text/markdown',
		};
		const harness = createIncrementalHarness({
			settings: { lastSeq: 10 },
			changes: [
				{
					seq: 11,
					path: 'notes/live.md',
					action: 'delete',
					hash: '',
					size: 0,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 11,
			localChanges: [{ path: 'notes/live.md', hash: 'local-hash' }],
		});
		const uploadPreparedFiles = vi.fn(async (uploads: PreparedUpload[], result: SyncResult) => {
			result.uploaded += uploads.length;
			result.uploadedPaths.push(...uploads.map(upload => upload.path));
		});
		harness.context.prepareUploadFromPath = vi.fn(async () => prepared);
		harness.context.uploadPreparedFiles = uploadPreparedFiles;

		const result = await runIncrementalSync(harness.context, { uploadConcurrency: 5 });

		expect(harness.api.deleteFile).not.toHaveBeenCalled();
		expect(uploadPreparedFiles).toHaveBeenCalledWith(
			[prepared],
			expect.any(Object),
			expect.objectContaining({ concurrency: 5 }),
		);
		expect(prepared.expectedHash).toBeNull();
		expect(result?.conflicts).toContain('notes/live.md');
		expect(result?.uploaded).toBe(1);
	});

	it('restores a remote edit when the same path was deleted locally', async () => {
		const path = 'notes/remote-edit.md';
		const harness = createIncrementalHarness({
			settings: { lastSeq: 10 },
			changes: [{
				seq: 11,
				path,
				action: 'put',
				hash: 'remote-edit',
				size: 12,
				created_at: '2026-02-06T12:00:00.000Z',
			}],
			lastSeq: 11,
			localDeletes: [path],
		});
		harness.localManifest.getEntry.mockReturnValue({
			hash: 'base',
			size: 8,
			modified: '2026-02-06T10:00:00.000Z',
		});
		harness.context.parallelDownloadAndSaveFiles = vi.fn(async (requests: unknown, result: SyncResult) => {
			result.downloaded++;
			result.downloadedPaths.push(path);
			expect(requests).toEqual([{
				path,
				expectedLocalHash: null,
				expectedRemoteHash: 'remote-edit',
				remoteSize: 12,
			}]);
		});

		const result = await runIncrementalSync(harness.context, { uploadConcurrency: 5 });

		expect(harness.api.batchDelete).not.toHaveBeenCalled();
		expect(result?.downloadedPaths).toContain(path);
		expect(result?.conflicts).toContain(path);
	});

	it('keeps a local delete when the remote put still matches the common version', async () => {
		const path = 'notes/delete.md';
		const harness = createIncrementalHarness({
			settings: { lastSeq: 10 },
			changes: [{
				seq: 11,
				path,
				action: 'put',
				hash: 'base',
				size: 8,
				created_at: '2026-02-06T12:00:00.000Z',
			}],
			lastSeq: 11,
			localDeletes: [path],
		});
		harness.localManifest.getEntry.mockReturnValue({
			hash: 'base',
			size: 8,
			modified: '2026-02-06T10:00:00.000Z',
		});

		const result = await runIncrementalSync(harness.context, { uploadConcurrency: 5 });

		expect(harness.api.batchDelete).toHaveBeenCalledWith([path], { [path]: 'base' });
		expect(result?.deletedPaths).toContain(path);
	});
});
