import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeHash } from './hasher';
import type { CrateSettings, FileEntry, PreparedUpload, SyncResult } from '../plugin/types';
import { MAX_FILE_SIZE_BYTES } from '../plugin/types';

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
	detectConflicts: conflictMocks.detectConflicts,
}));

import { createFullSyncPlan, getLocalChanges, getLocalDeletes, runIncrementalSync } from './planner';

function createSettings(overrides: Partial<CrateSettings> = {}): CrateSettings {
	return {
		workerUrl: 'https://worker.example',
		cloudflareAccountId: '',
		workerName: '',
		bucketName: '',
		databaseId: '',
		lastSync: null,
		lastSeq: 10,
		deviceId: 'dev-1',
		ignorePatterns: [],
		syncOnStartup: false,
		syncInterval: 0,
		showStatusBar: true,
		syncHistory: [],
		pushEnabled: false,
		syncDebugLogging: false,
		debounceDelay: 5,
		...overrides,
	};
}

describe('planner local diff helpers', () => {
	beforeEach(() => {
		fileDiscoveryMocks.getAllVaultFiles.mockReset();
		conflictMocks.detectConflicts.mockReset();
	});

	it('finds local deletes for non-ignored manifest paths', async () => {
		const adapter = {
			exists: vi.fn(async (path: string) => path !== 'notes/missing.md'),
		};

		const result = await getLocalDeletes(
			{
				vault: { adapter } as never,
				localManifest: {
					getAllPaths: () => ['notes/missing.md', '.trash/ignore.md'],
				} as never,
				shouldIgnore: (path: string) => path.startsWith('.trash/'),
				runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
			},
			5,
		);

		expect(result).toEqual(['notes/missing.md']);
		expect(adapter.exists).toHaveBeenCalledTimes(1);
	});

	it('detects changed local files by hash and skips unchanged ones', async () => {
		const unchangedContent = new TextEncoder().encode('same').buffer as ArrayBuffer;
		const changedContent = new TextEncoder().encode('changed').buffer as ArrayBuffer;
		const unchangedHash = await computeHash(unchangedContent);

		fileDiscoveryMocks.getAllVaultFiles.mockResolvedValue([
			{ path: 'notes/changed.md', size: 7, mtime: 100, extension: 'md' },
			{ path: 'notes/unchanged.md', size: 4, mtime: 100, extension: 'md' },
			{ path: 'notes/large.bin', size: MAX_FILE_SIZE_BYTES + 1, mtime: 100, extension: 'bin' },
		]);

		const adapter = {
			readBinary: vi.fn(async (path: string) =>
				path === 'notes/unchanged.md' ? unchangedContent : changedContent,
			),
		};

		const entries: Record<string, FileEntry> = {
			'notes/changed.md': {
				hash: 'old-hash',
				size: 7,
				modified: new Date(0).toISOString(),
			},
			'notes/unchanged.md': {
				hash: unchangedHash,
				size: 4,
				modified: new Date(0).toISOString(),
			},
		};

		const result = await getLocalChanges(
			{
				vault: { adapter } as never,
				localManifest: {
					getEntry: (path: string) => entries[path],
				} as never,
				shouldIgnore: () => false,
				runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
			},
			5,
		);

		expect(result).toHaveLength(1);
		expect(result[0]?.path).toBe('notes/changed.md');
		expect(result[0]?.hash).toHaveLength(64);
		expect(adapter.readBinary).toHaveBeenCalledTimes(2);
	});
});

describe('runIncrementalSync', () => {
	it('returns fast success and advances cursor when nothing changed', async () => {
		const settings = createSettings({ lastSeq: 5 });
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
			deleted: 0,
			conflicts: [],
			errors: [],
			uploadedPaths: [],
			downloadedPaths: [],
			deletedPaths: [],
		});
		expect(settings.lastSeq).toBe(8);
		expect(localManifest.save).not.toHaveBeenCalled();
	});

	it('applies remote downloads and local deletes during incremental planning', async () => {
		const settings = createSettings({ lastSeq: 7 });
		const localManifest = {
			save: vi.fn(async () => {}),
			setEntry: vi.fn(),
			removeEntry: vi.fn(),
			getEntry: vi.fn(),
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

		expect(parallelDownloadAndSaveFiles).toHaveBeenCalledWith(['notes/remote.md'], expect.any(Object));
		expect(batchDelete).toHaveBeenCalledWith(['notes/local-delete.md']);
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
			getEntry: vi.fn(),
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

	it('falls back to full sync when cursor is expired', async () => {
		const settings = createSettings({ lastSeq: 5 });
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
					changes: [],
					lastSeq: 20,
					hasMore: false,
					cursorExpired: true,
				})),
				downloadFile: vi.fn(),
				deleteFile: vi.fn(),
				batchDelete: vi.fn(async (paths: string[]) => ({ success: true, deleted: paths })),
			},
			localManifest: {
				save: vi.fn(),
				setEntry: vi.fn(),
				removeEntry: vi.fn(),
				getEntry: vi.fn(),
				getAllPaths: vi.fn(() => []),
				getManifest: vi.fn(() => ({ version: 1, files: {} })),
			},
			shouldIgnore: vi.fn(() => false),
			getLocalChanges: vi.fn(async () => []),
			getLocalDeletes: vi.fn(async () => []),
			parallelDownloadAndSaveFiles: vi.fn(async () => {}),
			processDiff: vi.fn(async () => {}),
			prepareUploadFromPath: vi.fn(async () => null),
			uploadPreparedFiles: vi.fn(async () => {}),
		};

		const result = await runIncrementalSync(context, { uploadConcurrency: 5 });

		expect(result).toBeNull();
		expect(settings.lastSeq).toBe(5);
		expect(context.getLocalChanges).not.toHaveBeenCalled();
	});

	it('reclassifies own queue uploads as local changes instead of conflicts', async () => {
		const queueUploadHash = 'abc123';
		const newLocalContent = new TextEncoder().encode('edited-after-queue').buffer as ArrayBuffer;
		const newLocalHash = await computeHash(newLocalContent);
		const settings = createSettings({ lastSeq: 10 });
		const localManifest = {
			save: vi.fn(async () => {}),
			setEntry: vi.fn(),
			removeEntry: vi.fn(),
			getEntry: vi.fn((path: string) =>
				path === 'notes/queued.md'
					? { hash: queueUploadHash, size: 10, modified: new Date(100).toISOString() }
					: undefined,
			),
			getAllPaths: vi.fn(() => []),
			getManifest: vi.fn(() => ({ version: 1, files: {} })),
		};
		const preparedUpload: PreparedUpload = {
			path: 'notes/queued.md',
			content: newLocalContent,
			hash: newLocalHash,
			size: newLocalContent.byteLength,
		};
		const uploadPreparedFiles = vi.fn(async () => {});

		const context = {
			settings,
			vault: {
				getAbstractFileByPath: vi.fn(() => ({ stat: { size: 18, mtime: 200 } })),
				delete: vi.fn(),
				adapter: {
					exists: vi.fn(async () => true),
					remove: vi.fn(),
					stat: vi.fn(async () => ({ size: 18, mtime: 200 })),
					readBinary: vi.fn(async () => newLocalContent),
				},
			} as never,
			api: {
				getChanges: vi.fn(async () => ({
					changes: [
						{
							seq: 11,
							path: 'notes/queued.md',
							action: 'put' as const,
							hash: queueUploadHash,
							size: 10,
							created_at: '2026-02-15T00:00:00.000Z',
						},
					],
					lastSeq: 11,
					hasMore: false,
				})),
				downloadFile: vi.fn(),
				deleteFile: vi.fn(),
				batchDelete: vi.fn(async (paths: string[]) => ({ success: true, deleted: paths })),
			},
			localManifest,
			shouldIgnore: vi.fn(() => false),
			getLocalChanges: vi.fn(async () => [{ path: 'notes/queued.md', hash: newLocalHash }]),
			getLocalDeletes: vi.fn(async () => []),
			parallelDownloadAndSaveFiles: vi.fn(async () => {}),
			processDiff: vi.fn(async () => {}),
			prepareUploadFromPath: vi.fn(async () => preparedUpload),
			uploadPreparedFiles,
		};

		const result = await runIncrementalSync(context, { uploadConcurrency: 5 });

		expect(result?.conflicts).toEqual([]);
		expect(uploadPreparedFiles).toHaveBeenCalledWith(
			[preparedUpload],
			expect.any(Object),
			expect.objectContaining({ concurrency: 5 }),
		);
		expect(context.processDiff).not.toHaveBeenCalled();
		expect(settings.lastSeq).toBe(11);
	});

	it('still detects true conflicts when changelog hash differs from manifest', async () => {
		const manifestHash = 'manifest-hash';
		const remoteHash = 'other-device-hash';
		const localContent = new TextEncoder().encode('local-edit').buffer as ArrayBuffer;
		const localHash = await computeHash(localContent);
		const settings = createSettings({ lastSeq: 10 });
		const localManifest = {
			save: vi.fn(async () => {}),
			setEntry: vi.fn(),
			removeEntry: vi.fn(),
			getEntry: vi.fn((path: string) =>
				path === 'notes/shared.md'
					? { hash: manifestHash, size: 5, modified: new Date(100).toISOString() }
					: undefined,
			),
			getAllPaths: vi.fn(() => []),
			getManifest: vi.fn(() => ({ version: 1, files: {} })),
		};
		const processDiff = vi.fn(async () => {});

		const context = {
			settings,
			vault: {
				getAbstractFileByPath: vi.fn(() => ({ stat: { size: 10, mtime: 200 } })),
				delete: vi.fn(),
				adapter: {
					exists: vi.fn(async () => true),
					remove: vi.fn(),
					stat: vi.fn(async () => ({ size: 10, mtime: 200 })),
					readBinary: vi.fn(async () => localContent),
				},
			} as never,
			api: {
				getChanges: vi.fn(async () => ({
					changes: [
						{
							seq: 11,
							path: 'notes/shared.md',
							action: 'put' as const,
							hash: remoteHash,
							size: 8,
							created_at: '2026-02-15T00:00:00.000Z',
						},
					],
					lastSeq: 11,
					hasMore: false,
				})),
				downloadFile: vi.fn(),
				deleteFile: vi.fn(),
				batchDelete: vi.fn(async (paths: string[]) => ({ success: true, deleted: paths })),
			},
			localManifest,
			shouldIgnore: vi.fn(() => false),
			getLocalChanges: vi.fn(async () => [{ path: 'notes/shared.md', hash: localHash }]),
			getLocalDeletes: vi.fn(async () => []),
			parallelDownloadAndSaveFiles: vi.fn(async () => {}),
			processDiff,
			prepareUploadFromPath: vi.fn(async () => null),
			uploadPreparedFiles: vi.fn(async () => {}),
		};

		const result = await runIncrementalSync(context, { uploadConcurrency: 5 });

		expect(processDiff).toHaveBeenCalledWith(
			expect.objectContaining({
				path: 'notes/shared.md',
				action: 'conflict',
				localHash,
				remoteHash,
			}),
			expect.any(Object),
			expect.any(Object),
		);
		expect(result?.conflicts).not.toContain('notes/shared.md');
	});

	it('falls back to full sync when changelog request throws', async () => {
		const context = {
			settings: createSettings({ lastSeq: 2 }),
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
				getChanges: vi.fn(async () => {
					throw new Error('network down');
				}),
				downloadFile: vi.fn(),
				deleteFile: vi.fn(),
				batchDelete: vi.fn(async (paths: string[]) => ({ success: true, deleted: paths })),
			},
			localManifest: {
				save: vi.fn(),
				setEntry: vi.fn(),
				removeEntry: vi.fn(),
				getEntry: vi.fn(),
				getAllPaths: vi.fn(() => []),
				getManifest: vi.fn(() => ({ version: 1, files: {} })),
			},
			shouldIgnore: vi.fn(() => false),
			getLocalChanges: vi.fn(async () => []),
			getLocalDeletes: vi.fn(async () => []),
			parallelDownloadAndSaveFiles: vi.fn(async () => {}),
			processDiff: vi.fn(async () => {}),
			prepareUploadFromPath: vi.fn(async () => null),
			uploadPreparedFiles: vi.fn(async () => {}),
		};

		const result = await runIncrementalSync(context, { uploadConcurrency: 5 });
		expect(result).toBeNull();
	});
});

describe('createFullSyncPlan', () => {
	beforeEach(() => {
		fileDiscoveryMocks.getAllVaultFiles.mockReset();
		conflictMocks.detectConflicts.mockReset();
	});

	it('filters ignored/missing/oversized diffs and classifies remaining work', async () => {
		fileDiscoveryMocks.getAllVaultFiles.mockResolvedValue([
			{ path: 'notes/upload.md', size: 2, mtime: 100, extension: 'md' },
			{ path: 'notes/conflict.md', size: 3, mtime: 100, extension: 'md' },
			{ path: 'notes/local-big.bin', size: MAX_FILE_SIZE_BYTES + 1, mtime: 100, extension: 'bin' },
		]);
		conflictMocks.detectConflicts.mockReturnValue([
			{ path: 'notes/upload.md', action: 'upload' },
			{ path: 'notes/download-missing.md', action: 'download' },
			{ path: 'notes/remote-big.md', action: 'download' },
			{ path: 'notes/local-big.bin', action: 'upload' },
			{ path: 'ignored/path.md', action: 'upload' },
			{ path: 'notes/conflict.md', action: 'conflict' },
		]);

		const removeEntry = vi.fn();
		const plan = await createFullSyncPlan(
			{
				vault: {
					adapter: {
						readBinary: vi.fn(async (path: string) =>
							new TextEncoder().encode(path.includes('conflict') ? 'c' : 'u').buffer as ArrayBuffer,
						),
					},
				} as never,
				localManifest: {
					getEntry: () => undefined,
					getManifest: () => ({
						version: 1,
						files: {
							'notes/deleted.md': {
								hash: 'same-hash',
								size: 1,
								modified: new Date(0).toISOString(),
							},
						},
					}),
					removeEntry,
				} as never,
				shouldIgnore: (path: string) => path.startsWith('ignored/'),
				runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
				getLocalDeletes: async () => ['notes/deleted.md', 'notes/orphan.md'],
			},
			{
				'notes/deleted.md': { hash: 'same-hash', size: 1, modified: new Date(0).toISOString() },
				'notes/remote-big.md': {
					hash: 'remote-big',
					size: MAX_FILE_SIZE_BYTES + 1,
					modified: new Date(0).toISOString(),
				},
			},
			5,
		);

		expect(plan.uploadDiffs).toEqual([{ path: 'notes/upload.md', action: 'upload' }]);
		expect(plan.downloadDiffs).toEqual([]);
		expect(plan.remainingDiffs).toEqual([
			{ path: 'notes/conflict.md', action: 'conflict' },
			{ path: 'notes/deleted.md', action: 'delete', remoteHash: 'same-hash' },
		]);
		expect(plan.errors).toContain('notes/local-big.bin: Skipped local file larger than 25MB');
		expect(plan.errors).toContain('notes/remote-big.md: Skipped remote file larger than 25MB');
		expect(removeEntry).toHaveBeenCalledWith('notes/orphan.md');
	});

	it('reuses manifest hash for files with matching mtime/size and only hashes changed files', async () => {
		const unchangedContent = new TextEncoder().encode('unchanged').buffer as ArrayBuffer;
		const unchangedHash = await computeHash(unchangedContent);
		const newContent = new TextEncoder().encode('new-file').buffer as ArrayBuffer;

		fileDiscoveryMocks.getAllVaultFiles.mockResolvedValue([
			{ path: 'notes/unchanged.md', size: 9, mtime: 1000, extension: 'md' },
			{ path: 'notes/new.md', size: 8, mtime: 2000, extension: 'md' },
			{ path: 'notes/size-changed.md', size: 20, mtime: 1000, extension: 'md' },
			{ path: 'notes/mtime-changed.md', size: 5, mtime: 3000, extension: 'md' },
		]);
		conflictMocks.detectConflicts.mockReturnValue([]);

		const readBinary = vi.fn(async () => newContent);

		const plan = await createFullSyncPlan(
			{
				vault: {
					adapter: { readBinary },
				} as never,
				localManifest: {
					getEntry: (path: string) => {
						if (path === 'notes/unchanged.md') {
							return { hash: unchangedHash, size: 9, modified: new Date(1000).toISOString() };
						}
						if (path === 'notes/size-changed.md') {
							return { hash: 'old-hash', size: 10, modified: new Date(1000).toISOString() };
						}
						if (path === 'notes/mtime-changed.md') {
							return { hash: 'old-hash', size: 5, modified: new Date(1000).toISOString() };
						}
						return undefined;
					},
					getManifest: () => ({ version: 1, files: {} }),
					removeEntry: vi.fn(),
				} as never,
				shouldIgnore: () => false,
				runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
				getLocalDeletes: async () => [],
			},
			{},
			5,
		);

		expect(readBinary).toHaveBeenCalledTimes(3);
		expect(readBinary).not.toHaveBeenCalledWith('notes/unchanged.md');
		expect(plan.localFiles['notes/unchanged.md']?.hash).toBe(unchangedHash);
	});
});
