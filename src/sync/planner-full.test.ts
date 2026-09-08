import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeHash } from './hasher';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { createFullSyncPlan } from './planner';

const fileDiscoveryMocks = vi.hoisted(() => ({
	getAllVaultFiles: vi.fn(),
	isHiddenPath: vi.fn((path: string) => path.split('/').some(segment => segment.startsWith('.'))),
}));

const conflictMocks = vi.hoisted(() => ({
	createConflictCopy: vi.fn(async () => 'notes/file (conflict).md'),
	classifyPaths: vi.fn(),
}));

vi.mock('./file-discovery', () => ({
	getAllVaultFiles: fileDiscoveryMocks.getAllVaultFiles,
	isHiddenPath: fileDiscoveryMocks.isHiddenPath,
}));

vi.mock('./conflict', () => ({
	createConflictCopy: conflictMocks.createConflictCopy,
}));

vi.mock('./reconciliation', async (importOriginal) => ({
	...await importOriginal<typeof import('./reconciliation')>(),
	classifyPaths: conflictMocks.classifyPaths,
}));

describe('createFullSyncPlan', () => {
	beforeEach(() => {
		fileDiscoveryMocks.getAllVaultFiles.mockReset();
		conflictMocks.classifyPaths.mockReset();
	});

	it('filters ignored/missing/oversized diffs and classifies remaining work', async () => {
		fileDiscoveryMocks.getAllVaultFiles.mockResolvedValue([
			{ path: 'notes/upload.md', size: 2, mtime: 100, extension: 'md' },
			{ path: 'notes/conflict.md', size: 3, mtime: 100, extension: 'md' },
			{ path: 'notes/local-big.bin', size: MAX_FILE_SIZE_BYTES + 1, mtime: 100, extension: 'bin' },
		]);
		conflictMocks.classifyPaths.mockReturnValue([
			{ path: 'notes/upload.md', action: 'upload' },
			{ path: 'notes/download-missing.md', action: 'download' },
			{ path: 'notes/remote-big.md', action: 'download' },
			{ path: 'notes/local-big.bin', action: 'upload' },
			{ path: 'ignored/path.md', action: 'upload' },
			{ path: 'notes/conflict.md', action: 'conflict' },
			{ path: 'notes/deleted.md', action: 'delete', remoteHash: 'same-hash' },
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
							'notes/orphan.md': {
								hash: 'orphan-hash',
								size: 1,
								modified: new Date(0).toISOString(),
							},
						},
					}),
					removeEntry,
				} as never,
				shouldIgnore: (path: string) => path.startsWith('ignored/'),
				runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
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

	it('hashes every file during full reconciliation regardless of matching metadata', async () => {
		const unchangedContent = new TextEncoder().encode('unchanged').buffer as ArrayBuffer;
		const unchangedHash = await computeHash(unchangedContent);
		const newContent = new TextEncoder().encode('new-file').buffer as ArrayBuffer;

		fileDiscoveryMocks.getAllVaultFiles.mockResolvedValue([
			{ path: 'notes/unchanged.md', size: 9, mtime: 1000, extension: 'md' },
			{ path: 'notes/new.md', size: 8, mtime: 2000, extension: 'md' },
			{ path: 'notes/size-changed.md', size: 20, mtime: 1000, extension: 'md' },
			{ path: 'notes/mtime-changed.md', size: 5, mtime: 3000, extension: 'md' },
		]);
		conflictMocks.classifyPaths.mockReturnValue([]);

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
			},
			{},
			5,
		);

		expect(readBinary).toHaveBeenCalledTimes(4);
		expect(readBinary).toHaveBeenCalledWith('notes/unchanged.md');
		expect(plan.localFiles['notes/unchanged.md']?.hash).toBe(await computeHash(newContent));
	});
});
