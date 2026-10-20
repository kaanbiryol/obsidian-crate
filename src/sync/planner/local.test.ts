import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import { getLocalChanges, getLocalDeletes } from './planner';
import { sha256Hex } from '../../platform/sha256';

const fileDiscoveryMocks = vi.hoisted(() => ({
	getAllVaultFiles: vi.fn(),
	isHiddenPath: vi.fn((path: string) => path.split('/').some(segment => segment.startsWith('.'))),
}));

const conflictMocks = vi.hoisted(() => ({
	createConflictCopy: vi.fn(async () => 'notes/file (conflict).md'),
}));

vi.mock('../local/file-discovery', () => ({
	getAllVaultFiles: fileDiscoveryMocks.getAllVaultFiles,
	isHiddenPath: fileDiscoveryMocks.isHiddenPath,
}));

vi.mock('../conflict/conflict', () => ({
	createConflictCopy: conflictMocks.createConflictCopy,
}));

describe('planner local diff helpers', () => {
	beforeEach(() => {
		fileDiscoveryMocks.getAllVaultFiles.mockReset();
	});

	it('confirms only non-ignored manifest paths missing from discovery', async () => {
		const adapter = {
			exists: vi.fn(async (path: string) => path === 'notes/unindexed.md'),
		};

		const result = await getLocalDeletes(
			{
				vault: { adapter } as never,
				localManifest: {
					getAllPaths: () => ['notes/present.md', 'notes/missing.md', 'notes/unindexed.md', '.trash/ignore.md'],
				} as never,
				throwIfDestroyed: () => {}, shouldIgnore: (path: string) => path.startsWith('.trash/'),
				runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
			},
			new Set(['notes/present.md']),
			5,
		);

		expect(result).toEqual(['notes/missing.md']);
		expect(adapter.exists.mock.calls.map(([path]) => path)).toEqual(['notes/missing.md', 'notes/unindexed.md']);
	});

	it('detects changed local files by hash and skips unchanged ones', async () => {
		const unchangedContent = new TextEncoder().encode('same').buffer;
		const changedContent = new TextEncoder().encode('changed').buffer;
		const unchangedHash = await sha256Hex(unchangedContent);

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
				throwIfDestroyed: () => {}, shouldIgnore: () => false,
				runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
			},
			5,
		);

		expect(result.changes).toHaveLength(1);
		expect(result.changes.find(file => file.path === 'notes/changed.md')?.hash).toHaveLength(64);
		expect(result.skippedPaths).toEqual(['notes/large.bin']);
		expect(result.discoveredPaths).toEqual(new Set(['notes/changed.md', 'notes/unchanged.md', 'notes/large.bin']));
		expect(adapter.readBinary).toHaveBeenCalledTimes(2);
	});
});
