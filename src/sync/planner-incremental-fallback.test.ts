import { describe, expect, it, vi } from 'vitest';
import { computeHash } from './hasher';
import type { PreparedUpload } from './types';
import { runIncrementalSync } from './planner';
import { createSettings } from './planner-test-harness';

const fileDiscoveryMocks = vi.hoisted(() => ({
	getAllVaultFiles: vi.fn(),
	isHiddenPath: vi.fn((path: string) => path.split('/').some(segment => segment.startsWith('.'))),
}));

const conflictMocks = vi.hoisted(() => ({
	createConflictCopy: vi.fn(async () => 'notes/file (conflict).md'),
}));

vi.mock('./file-discovery', () => ({
	getAllVaultFiles: fileDiscoveryMocks.getAllVaultFiles,
	isHiddenPath: fileDiscoveryMocks.isHiddenPath,
}));

vi.mock('./conflict', () => ({
	createConflictCopy: conflictMocks.createConflictCopy,
}));

describe('runIncrementalSync', () => {
it('falls back to full sync when cursor is expired', async () => {
		const settings = createSettings({ lastSeq: 5 });
		const context = {
			settings,
			fileManager: { trashFile: vi.fn(async () => {}) },
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
			processDiff: vi.fn(async () => ({ status: 'applied' as const })),
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
			fileManager: { trashFile: vi.fn(async () => {}) },
			vault: {
				getAbstractFileByPath: vi.fn(() => ({
					path: 'notes/queued.md',
					extension: 'md',
					stat: { size: 18, mtime: 200 },
				})),
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
			processDiff: vi.fn(async () => ({ status: 'applied' as const })),
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
		const processDiff = vi.fn(async () => ({ status: 'applied' as const }));

		const context = {
			settings,
			fileManager: { trashFile: vi.fn(async () => {}) },
			vault: {
				getAbstractFileByPath: vi.fn(() => ({
					path: 'notes/shared.md',
					extension: 'md',
					stat: { size: 10, mtime: 200 },
				})),
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
			fileManager: { trashFile: vi.fn(async () => {}) },
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
			processDiff: vi.fn(async () => ({ status: 'applied' as const })),
			prepareUploadFromPath: vi.fn(async () => null),
			uploadPreparedFiles: vi.fn(async () => {}),
		};

		const result = await runIncrementalSync(context, { uploadConcurrency: 5 });
		expect(result).toBeNull();
	});
});
