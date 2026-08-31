import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeHash } from './hasher';
import type { FileEntry } from '../plugin/types';
import { MAX_FILE_SIZE_BYTES } from '../plugin/types';
import { getLocalChanges, getLocalDeletes } from './planner';

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

vi.mock('./reconciliation', async (importOriginal) => ({
	...await importOriginal<typeof import('./reconciliation')>(),
	detectConflicts: conflictMocks.detectConflicts,
}));

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
					setEntry: (path: string, entry: FileEntry) => {
						entries[path] = entry;
					},
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
