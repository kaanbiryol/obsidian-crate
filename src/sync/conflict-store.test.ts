import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllVaultFiles } from './file-discovery';
import { ConflictStore } from './conflict-store';

vi.mock('./file-discovery', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./file-discovery')>();
	return { ...actual, getAllVaultFiles: vi.fn() };
});

const getAllVaultFilesMock = vi.mocked(getAllVaultFiles);

function createHarness(initial: Record<string, string> = {}) {
	const files = new Map(Object.entries(initial));
	const adapter = {
		exists: vi.fn(async (path: string) => files.has(path)),
		read: vi.fn(async (path: string) => files.get(path) ?? ''),
		write: vi.fn(async (path: string, value: string) => {
			files.set(path, value);
		}),
		remove: vi.fn(async (path: string) => {
			files.delete(path);
		}),
	};
	const app = { vault: { adapter, getFiles: () => [] } };
	const counts: number[] = [];
	const store = new ConflictStore(
		app as never,
		{ dir: '.obsidian/plugins/crate' } as never,
		(count) => counts.push(count),
	);
	return { adapter, counts, files, store };
}

describe('ConflictStore', () => {
	beforeEach(() => {
		getAllVaultFilesMock.mockReset();
		getAllVaultFilesMock.mockResolvedValue([]);
	});

	it('persists the original path and hashes for an active conflict', async () => {
		const harness = createHarness();
		await harness.store.load();
		await harness.store.record({
			originalPath: 'notes/shared.md',
			conflictPath: 'notes/shared (conflict 2026-01-02 03-04-05 ab12).md',
			cause: 'concurrent-edit',
			localHash: 'local',
			remoteHash: 'remote',
			baseHash: 'base',
		});

		expect(harness.store.getActiveConflicts()).toMatchObject([{
			originalPath: 'notes/shared.md',
			localHash: 'local',
			remoteHash: 'remote',
			baseHash: 'base',
			status: 'active',
		}]);
		expect(harness.counts.at(-1)).toBe(1);
		expect(harness.files.get('.obsidian/plugins/crate/conflicts.json')).toContain('notes/shared.md');
	});

	it('loads persisted metadata without scanning the vault', async () => {
		const harness = createHarness();

		await harness.store.load();

		expect(getAllVaultFilesMock).not.toHaveBeenCalled();
	});

	it('recovers an untracked visible or hidden conflict copy in the background', async () => {
		const conflictPath = '.archive/shared (conflict 2026-01-02 03-04-05 ab12).md';
		getAllVaultFilesMock.mockResolvedValue([{
			path: conflictPath,
			size: 1,
			mtime: 1,
			extension: 'md',
		}]);
		const harness = createHarness({ [conflictPath]: 'copy' });

		await harness.store.load();
		await harness.store.recoverFromVault(() => false);

		expect(harness.store.getActiveConflicts()).toMatchObject([{
			originalPath: '.archive/shared.md',
			conflictPath,
			cause: 'unknown',
		}]);
	});

	it('uses configured ignore rules and excludes its own data during recovery', async () => {
		const harness = createHarness();

		await harness.store.load();
		await harness.store.recoverFromVault(
			(path) => path === '.git' || path.startsWith('.git/'),
		);

		const shouldIgnore = getAllVaultFilesMock.mock.calls[0]?.[1];
		expect(shouldIgnore).toBeDefined();
		expect(shouldIgnore?.('.git')).toBe(true);
		expect(shouldIgnore?.('.git/objects')).toBe(true);
		expect(shouldIgnore?.('.obsidian/plugins/crate')).toBe(true);
		expect(shouldIgnore?.('.obsidian/plugins/crate/cache/data')).toBe(true);
		expect(shouldIgnore?.('notes/shared (conflict 2026-01-02 03-04-05 ab12).md')).toBe(false);
	});

	it('recovers a corrupt main store from its temporary file', async () => {
		const conflictPath = 'notes/shared (conflict 2026-01-02 03-04-05 ab12).md';
		getAllVaultFilesMock.mockResolvedValue([{
			path: conflictPath,
			size: 1,
			mtime: 1,
			extension: 'md',
		}]);
		const recovered = JSON.stringify({
			version: 1,
			conflicts: [{
				originalPath: 'notes/shared.md',
				conflictPath,
				createdAt: '2026-01-02T03:04:05.000Z',
				cause: 'concurrent-edit',
				status: 'active',
			}],
		});
		const harness = createHarness({
			'.obsidian/plugins/crate/conflicts.json': '{',
			'.obsidian/plugins/crate/conflicts.json.tmp': recovered,
			[conflictPath]: 'copy',
		});

		await harness.store.load();

		expect(harness.store.getActiveConflicts()).toHaveLength(1);
		expect(harness.files.get('.obsidian/plugins/crate/conflicts.json')).toBe(recovered);
		expect(harness.files.has('.obsidian/plugins/crate/conflicts.json.tmp')).toBe(false);
	});

	it('marks a conflict resolved when its copy is deleted', async () => {
		const harness = createHarness();
		await harness.store.load();
		const conflictPath = 'notes/shared (conflict 2026-01-02 03-04-05 ab12).md';
		await harness.store.registerDiscovered(conflictPath);

		await harness.store.markResolved(conflictPath);

		expect(harness.store.getActiveConflicts()).toEqual([]);
		expect(harness.counts.at(-1)).toBe(0);
	});

	it('serializes discovery and metadata recording for the same conflict copy', async () => {
		const harness = createHarness();
		await harness.store.load();
		const conflictPath = 'notes/shared (conflict 2026-01-02 03-04-05 ab12).md';

		await Promise.all([
			harness.store.registerDiscovered(conflictPath),
			harness.store.record({
				originalPath: 'notes/shared.md',
				conflictPath,
				cause: 'concurrent-edit',
				localHash: 'local',
				remoteHash: 'remote',
			}),
		]);

		expect(harness.store.getActiveConflicts()).toMatchObject([{
			conflictPath,
			cause: 'concurrent-edit',
			localHash: 'local',
			remoteHash: 'remote',
		}]);
	});
});
