import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vault } from 'obsidian';
import { getAllVaultFiles } from './file-discovery';
import { hasHiddenFileChanges } from './hidden-file-changes';

vi.mock('./file-discovery', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./file-discovery')>();
	return { ...actual, getAllVaultFiles: vi.fn() };
});

const getAllVaultFilesMock = vi.mocked(getAllVaultFiles);
const HIDDEN_FILE_PATH = '.hidden/config.json';

function createHarness() {
	const entries = new Map([
		[HIDDEN_FILE_PATH, {
			hash: 'hash',
			size: 12,
			modified: new Date(1_700_000_000_000).toISOString(),
		}],
	]);
	const exists = vi.fn(async () => true);
	const vault = { adapter: { exists } } as unknown as Vault;
	const manifest = {
		getAllPaths: () => [...entries.keys()],
		getEntry: (path: string) => entries.get(path),
	};
	return { entries, exists, manifest, vault };
}

describe('hasHiddenFileChanges', () => {
	beforeEach(() => {
		getAllVaultFilesMock.mockReset();
	});

	it('returns false when tracked hidden metadata is unchanged', async () => {
		const harness = createHarness();
		getAllVaultFilesMock.mockResolvedValue([{
			path: HIDDEN_FILE_PATH,
			size: 12,
			mtime: 1_700_000_000_000,
			extension: 'json',
		}]);

		await expect(hasHiddenFileChanges(harness.vault, harness.manifest, () => false))
			.resolves.toBe(false);
	});

	it('detects new or modified hidden files', async () => {
		const harness = createHarness();
		getAllVaultFilesMock.mockResolvedValue([{
			path: HIDDEN_FILE_PATH,
			size: 13,
			mtime: 1_700_000_000_001,
			extension: 'json',
		}]);

		await expect(hasHiddenFileChanges(harness.vault, harness.manifest, () => false))
			.resolves.toBe(true);
	});

	it('detects deleted tracked hidden files', async () => {
		const harness = createHarness();
		harness.exists.mockResolvedValue(false);
		getAllVaultFilesMock.mockResolvedValue([]);

		await expect(hasHiddenFileChanges(harness.vault, harness.manifest, () => false))
			.resolves.toBe(true);
	});

	it('does not treat a transient discovery omission as a deletion', async () => {
		const harness = createHarness();
		getAllVaultFilesMock.mockResolvedValue([]);

		await expect(hasHiddenFileChanges(harness.vault, harness.manifest, () => false))
			.resolves.toBe(false);
	});
});
