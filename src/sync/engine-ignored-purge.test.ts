import { describe, expect, it } from 'vitest';
import { createHarness } from './engine-test-harness';
import { BATCH_DELETE_MAX_FILES } from '../protocol/sync-limits';

describe('ignored remote cleanup', () => {
	it('persists acknowledged batches before reporting cancelled remote cleanup', async () => {
		const h = createHarness();
		const paths = Array.from({ length: BATCH_DELETE_MAX_FILES + 1 }, (_, index) => `.trash/deleted-${index}.md`);
		h.api.getManifest.mockResolvedValue({ version: 1, files: Object.fromEntries(paths.map(path => [path, { hash: 'a'.repeat(64), size: 1, modified: 'now', revision: 'v1' }])) });
		h.api.batchDelete.mockImplementationOnce(async (deleted: string[]) => ({ success: true, deleted }))
			.mockRejectedValueOnce(new DOMException('Delete cancelled', 'AbortError'));
		await expect(h.engine.purgeIgnoredRemoteFiles()).rejects.toMatchObject({ name: 'AbortError' });
		expect(h.localManifest.removeEntry.mock.calls.map(([path]) => path)).toEqual(paths.slice(0, -1));
		expect(h.localManifest.save).toHaveBeenCalledOnce();
	});

	it('deletes only ignored remote files with compare-and-swap hashes', async () => {
		const harness = createHarness();
		const files = {
			'.trash/old.md': { hash: 'a'.repeat(64), size: 1, modified: 'now', revision: 'version-1' },
			'notes/draft.tmp': { hash: 'b'.repeat(64), size: 1, modified: 'now', revision: 'version-1' },
			'notes/keep.md': { hash: 'c'.repeat(64), size: 1, modified: 'now', revision: 'version-1' },
		};
		harness.api.getManifest.mockResolvedValue({ version: 1, files, lastSeq: 1 });

		await expect(harness.engine.previewIgnoredRemoteFiles()).resolves.toEqual([
			'.trash/old.md',
			'notes/draft.tmp',
		]);
		const result = await harness.engine.purgeIgnoredRemoteFiles();

		expect(result).toEqual({ deleted: ['.trash/old.md', 'notes/draft.tmp'], errors: [] });
		expect(harness.api.batchDelete).toHaveBeenCalledWith(
			['.trash/old.md', 'notes/draft.tmp'],
			{
				'.trash/old.md': 'a'.repeat(64),
				'notes/draft.tmp': 'b'.repeat(64),
			},
      { '.trash/old.md': 'version-1', 'notes/draft.tmp': 'version-1' },
		);
		expect(harness.localManifest.removeEntry).toHaveBeenCalledTimes(2);
		expect(harness.localManifest.save).toHaveBeenCalledOnce();
	});
});
