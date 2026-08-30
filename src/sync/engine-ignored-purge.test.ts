import { describe, expect, it } from 'vitest';
import { createHarness } from './engine-test-harness';

describe('ignored remote cleanup', () => {
	it('deletes only ignored remote files with compare-and-swap hashes', async () => {
		const harness = createHarness();
		const files = {
			'.trash/old.md': { hash: 'a'.repeat(64), size: 1, modified: 'now' },
			'notes/draft.tmp': { hash: 'b'.repeat(64), size: 1, modified: 'now' },
			'notes/keep.md': { hash: 'c'.repeat(64), size: 1, modified: 'now' },
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
		);
		expect(harness.localManifest.removeEntry).toHaveBeenCalledTimes(2);
		expect(harness.localManifest.save).toHaveBeenCalledOnce();
	});
});
