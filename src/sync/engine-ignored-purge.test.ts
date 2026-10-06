import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './engine-test-harness';
import { BATCH_DELETE_MAX_FILES } from '../protocol/sync-limits';
import { createDeferred } from './runtime-test-harness';

const engines: ReturnType<typeof createHarness>['engine'][] = [];
function harness() {
	const h = createHarness();
	engines.push(h.engine);
	return h;
}
afterEach(async () => {
	for (const engine of engines.splice(0)) {
		engine.destroy();
		await engine.waitForIdle();
	}
});

const entry = { hash: 'a'.repeat(64), size: 1, modified: 'now', revision: 'v1' };

describe('ignored remote cleanup', () => {
	it('persists acknowledged batches before reporting cancelled remote cleanup', async () => {
		const h = harness();
		const paths = Array.from({ length: BATCH_DELETE_MAX_FILES + 1 }, (_, index) => `.trash/deleted-${index}.md`);
		h.api.getManifest.mockResolvedValue({ version: 1, files: Object.fromEntries(paths.map(path => [path, { hash: 'a'.repeat(64), size: 1, modified: 'now', revision: 'v1' }])) });
		h.api.batchDelete.mockImplementationOnce(async (deleted: string[]) => ({ success: true, deleted }))
			.mockRejectedValueOnce(new DOMException('Delete cancelled', 'AbortError'));
		const review = await h.engine.createExclusionCleanupReview();
		await expect(review.execute()).rejects.toMatchObject({ name: 'AbortError' });
		expect(h.localManifest.removeEntry.mock.calls.map(([path]) => path)).toEqual(paths.slice(0, -1));
		expect(h.localManifest.save).toHaveBeenCalledOnce();
	});

	it('deletes only ignored remote files with compare-and-swap hashes', async () => {
		const h = harness();
		const files = {
			'.trash/old.md': { hash: 'a'.repeat(64), size: 1, modified: 'now', revision: 'version-1' },
			'notes/draft.tmp': { hash: 'b'.repeat(64), size: 1, modified: 'now', revision: 'version-1' },
			'notes/keep.md': { hash: 'c'.repeat(64), size: 1, modified: 'now', revision: 'version-1' },
		};
		h.api.getManifest.mockResolvedValue({ version: 1, files, lastSeq: 1 });

		const review = await h.engine.createExclusionCleanupReview();
		expect(review.paths).toEqual([
			'.trash/old.md',
			'notes/draft.tmp',
		]);
		const result = await review.execute();

		expect(result).toEqual({ deleted: ['.trash/old.md', 'notes/draft.tmp'], errors: [] });
		expect(h.api.batchDelete).toHaveBeenCalledWith(
			['.trash/old.md', 'notes/draft.tmp'],
			{
				'.trash/old.md': 'a'.repeat(64),
				'notes/draft.tmp': 'b'.repeat(64),
			},
      { '.trash/old.md': 'version-1', 'notes/draft.tmp': 'version-1' },
		);
		expect(h.localManifest.removeEntry).toHaveBeenCalledTimes(2);
		expect(h.localManifest.save).toHaveBeenCalledOnce();
	});

	it('retains reviewed paths and versions when the remote inventory changes', async () => {
		const h = harness();
		const files = { '.trash/reviewed.md': { ...entry } };
		h.api.getManifest.mockResolvedValue({ version: 1, files });
		const review = await h.engine.createExclusionCleanupReview();
		files['.trash/reviewed.md'].hash = 'b'.repeat(64);
		files['.trash/reviewed.md'].revision = 'v2';
		h.api.getManifest.mockResolvedValue({ version: 1, files: { ...files, '.trash/new.md': entry } });
		h.api.batchDelete.mockResolvedValue({ success: false, deleted: [], errors: [{ path: '.trash/reviewed.md', error: 'Remote file changed', status: 409 }] });
		await expect(review.execute()).resolves.toEqual({ deleted: [], errors: ['.trash/reviewed.md: Remote file changed'] });
		expect(h.api.getManifest).toHaveBeenCalledOnce();
		expect(h.api.batchDelete).toHaveBeenCalledExactlyOnceWith(['.trash/reviewed.md'], { '.trash/reviewed.md': entry.hash }, { '.trash/reviewed.md': 'v1' });
		expect(h.localManifest.removeEntry).not.toHaveBeenCalled();
	});

	it.each(['review', 'confirmation'] as const)('rejects exclusions changed during %s', async stage => {
		const h = harness();
		const remote = createDeferred<{ version: number; files: Record<string, typeof entry> }>();
		h.api.getManifest.mockReturnValue(remote.promise);
		const preparing = h.engine.createExclusionCleanupReview();
		if (stage === 'review') h.engine.updateSettings({ ...h.settings, ignorePatterns: ['other/'] });
		remote.resolve({ version: 1, files: { '.trash/old.md': entry } });
		if (stage === 'review') await expect(preparing).rejects.toThrow('Sync exclusions changed');
		else {
			const review = await preparing;
			h.engine.updateSettings({ ...h.settings, ignorePatterns: ['other/'] });
			await expect(review.execute()).rejects.toThrow('Sync exclusions changed');
		}
		expect(h.api.batchDelete).not.toHaveBeenCalled();
	});

	it('persists earlier acknowledgements before rejecting exclusions changed between batches', async () => {
		const h = harness();
		const paths = Array.from({ length: BATCH_DELETE_MAX_FILES + 1 }, (_, index) => `.trash/${index}.md`);
		h.api.getManifest.mockResolvedValue({ version: 1, files: Object.fromEntries(paths.map(path => [path, entry])) });
		const review = await h.engine.createExclusionCleanupReview();
		h.api.batchDelete.mockImplementationOnce(async (deleted: string[]) => {
			h.engine.updateSettings({ ...h.settings, ignorePatterns: ['other/'] });
			return { success: true, deleted };
		});
		await expect(review.execute()).rejects.toThrow('Sync exclusions changed');
		expect(h.api.batchDelete).toHaveBeenCalledOnce();
		expect(h.localManifest.removeEntry.mock.calls.map(([path]) => path)).toEqual(paths.slice(0, -1));
		expect(h.localManifest.save).toHaveBeenCalledOnce();
	});

	it('blocks another sync until cleanup acknowledgements are saved', async () => {
		const h = harness();
		h.api.getManifest.mockResolvedValue({ version: 1, files: { '.trash/old.md': entry } });
		const review = await h.engine.createExclusionCleanupReview();
		const saved = createDeferred<void>();
		h.localManifest.save.mockReturnValueOnce(saved.promise);
		const cleaning = review.execute();
		await vi.waitFor(() => expect(h.localManifest.save).toHaveBeenCalledOnce());
		expect(h.engine.getState().status).toBe('syncing');
		expect((await h.engine.initialSync()).errors).toEqual(['Sync already in progress']);
		saved.resolve();
		await cleaning;
		expect(h.engine.getState().status).toBe('idle');
	});

	it('rejects cleanup while another sync owns the engine', async () => {
		const h = harness();
		h.api.getManifest.mockResolvedValueOnce({ version: 1, files: { '.trash/old.md': entry } });
		const review = await h.engine.createExclusionCleanupReview();
		const remote = createDeferred<{ version: number; files: Record<string, never>; lastSeq: number }>();
		h.api.getManifest.mockReturnValueOnce(remote.promise);
		h.vault.getFiles.mockReturnValue([]);
		h.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		const syncing = h.engine.sync();
		await vi.waitFor(() => expect(h.api.getManifest).toHaveBeenCalledTimes(2));
		await expect(review.execute()).rejects.toThrow('Wait for sync to finish');
		expect(h.api.batchDelete).not.toHaveBeenCalled();
		remote.resolve({ version: 1, files: {}, lastSeq: 1 });
		await syncing;
	});
});
