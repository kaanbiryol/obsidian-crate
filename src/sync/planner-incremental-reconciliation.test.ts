import { describe, expect, it, vi } from 'vitest';
import type { PreparedUpload, SyncResult } from '../plugin/types';
import { MAX_FILE_SIZE_BYTES } from '../plugin/types';
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
it('chunks more than one server batch of local deletes', async () => {
		const paths = Array.from({ length: 14 }, (_, index) => `notes/delete-${index}.md`);
		const harness = createIncrementalHarness({
			settings: { lastSeq: 10 },
			lastSeq: 11,
			localDeletes: paths,
		});
		harness.localManifest.getEntry.mockReturnValue({
			hash: 'a'.repeat(64),
			size: 1,
			modified: '2026-02-06T10:00:00.000Z',
		});

		const result = await runIncrementalSync(harness.context, { uploadConcurrency: 5 });

		expect(harness.api.batchDelete.mock.calls.map(([chunk]) => chunk.length)).toEqual([6, 6, 2]);
		expect(result?.deletedPaths).toEqual(paths);
		expect(result?.success).toBe(true);
	});

	it('applies remote downloads and local deletes during incremental planning', async () => {
		const settings = createSettings({ lastSeq: 7 });
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
		const batchDelete = vi.fn(async (paths: string[]) => ({ success: true, deleted: paths }));
		const parallelDownloadAndSaveFiles = vi.fn(async (paths: string[], result: SyncResult) => {
			result.downloaded += paths.length;
		});
		const uploadPreparedFiles = vi.fn(async (prepared: PreparedUpload[], _result: SyncResult) => {
			expect(prepared).toEqual([]);
		});

		const context = {
			settings,
			vault: {
				getAbstractFileByPath: vi.fn(() => null),
				delete: vi.fn(),
				adapter: {
					exists: vi.fn(async () => false),
					remove: vi.fn(),
					stat: vi.fn(),
					readBinary: vi.fn(),
				},
			} as never,
			api: {
				getChanges: vi.fn(async () => ({
					changes: [
						{
							seq: 8,
							path: 'notes/remote.md',
							action: 'put' as const,
							hash: 'remote-hash',
							size: 12,
							created_at: '2026-02-15T00:00:00.000Z',
						},
					],
					lastSeq: 8,
					hasMore: false,
				})),
				downloadFile: vi.fn(),
				deleteFile: vi.fn(),
				batchDelete,
			},
			localManifest,
			shouldIgnore: vi.fn(() => false),
			getLocalChanges: vi.fn(async () => []),
			getLocalDeletes: vi.fn(async () => ['notes/local-delete.md']),
			parallelDownloadAndSaveFiles,
			processDiff: vi.fn(async () => {}),
			prepareUploadFromPath: vi.fn(async () => null),
			uploadPreparedFiles,
		};

		const result = await runIncrementalSync(context, { uploadConcurrency: 5 });

		expect(parallelDownloadAndSaveFiles).toHaveBeenCalledWith([
			{ path: 'notes/remote.md', expectedLocalHash: null, expectedRemoteHash: 'remote-hash', remoteSize: 12 },
		], expect.any(Object));
		expect(batchDelete).toHaveBeenCalledWith(
			['notes/local-delete.md'],
			{ 'notes/local-delete.md': 'a'.repeat(64) },
		);
		expect(localManifest.removeEntry).toHaveBeenCalledWith('notes/local-delete.md');
		expect(result?.success).toBe(true);
		expect(result?.downloaded).toBe(1);
		expect(result?.deleted).toBe(1);
		expect(settings.lastSeq).toBe(8);
		expect(localManifest.save).toHaveBeenCalledTimes(1);
	});

	it('records partial remote delete failures and leaves the sync cursor unchanged', async () => {
		const settings = createSettings({ lastSeq: 7 });
		const localManifest = {
			save: vi.fn(async () => {}),
			setEntry: vi.fn(),
			removeEntry: vi.fn(),
			getEntry: vi.fn((path: string) => ({
				hash: path === 'notes/ok.md' ? 'b'.repeat(64) : 'c'.repeat(64),
				size: 1,
				modified: '2026-02-15T00:00:00.000Z',
			})),
			getAllPaths: vi.fn(() => []),
			getManifest: vi.fn(() => ({ version: 1, files: {} })),
		};

		const context = {
			settings,
			vault: {
				getAbstractFileByPath: vi.fn(() => null),
				delete: vi.fn(),
				adapter: {
					exists: vi.fn(async () => false),
					remove: vi.fn(),
					stat: vi.fn(),
					readBinary: vi.fn(),
				},
			} as never,
			api: {
				getChanges: vi.fn(async () => ({ changes: [], lastSeq: 8, hasMore: false })),
				downloadFile: vi.fn(),
				deleteFile: vi.fn(),
				batchDelete: vi.fn(async () => ({
					success: false,
					deleted: ['notes/ok.md'],
					errors: [
						{ path: 'notes/fail.md', error: 'bucket unavailable' },
					],
				})),
			},
			localManifest,
			shouldIgnore: vi.fn(() => false),
			getLocalChanges: vi.fn(async () => []),
			getLocalDeletes: vi.fn(async () => ['notes/ok.md', 'notes/fail.md']),
			parallelDownloadAndSaveFiles: vi.fn(async () => {}),
			processDiff: vi.fn(async () => {}),
			prepareUploadFromPath: vi.fn(async () => null),
			uploadPreparedFiles: vi.fn(async () => {}),
		};

		const result = await runIncrementalSync(context, { uploadConcurrency: 5 });

		expect(localManifest.removeEntry).toHaveBeenCalledWith('notes/ok.md');
		expect(localManifest.removeEntry).not.toHaveBeenCalledWith('notes/fail.md');
		expect(result?.success).toBe(false);
		expect(result?.deleted).toBe(1);
		expect(result?.errors).toContain('notes/fail.md: bucket unavailable');
		expect(settings.lastSeq).toBe(7);
		expect(localManifest.save).toHaveBeenCalledTimes(1);
	});

	it('keeps cursor unchanged when incremental sync finishes with errors', async () => {
		const settings = createSettings({ lastSeq: 11 });
		const localManifest = {
			save: vi.fn(async () => {}),
			setEntry: vi.fn(),
			removeEntry: vi.fn(),
			getEntry: vi.fn(),
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
				getChanges: vi.fn(async () => ({
					changes: [
						{
							seq: 12,
							path: 'notes/too-big.bin',
							action: 'put' as const,
							hash: 'hash',
							size: MAX_FILE_SIZE_BYTES + 1,
							created_at: '2026-02-15T00:00:00.000Z',
						},
					],
					lastSeq: 12,
					hasMore: false,
				})),
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

		expect(result?.success).toBe(false);
		expect(result?.errors).toContain('notes/too-big.bin: Skipped remote file larger than 25MB');
		expect(settings.lastSeq).toBe(11);
		expect(localManifest.save).toHaveBeenCalledTimes(1);
	});
});
