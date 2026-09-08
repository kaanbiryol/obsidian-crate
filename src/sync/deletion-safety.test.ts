import { describe, expect, it } from 'vitest';
import { createHarness } from './engine-test-harness';
import { createIncrementalHarness } from './planner-test-harness';
import { runIncrementalSync } from './planner-incremental';
import { assertLocalFileAbsent } from './local-absence';

const path = '.private/note.md';
const entry = { hash: 'a'.repeat(64), revision: 'original-incarnation', size: 4, modified: new Date(1000).toISOString() };

describe('destructive sync requires complete discovery', () => {
	for (const mode of ['full', 'expired-cursor', 'force'] as const) {
		it.each(['root-list', 'hidden-list', 'nested-list', 'stat'])(`${mode} preserves remote files and checkpoint after %s failure`, async failure => {
			const harness = createHarness({ lastSeq: mode === 'expired-cursor' ? 5 : 0 });
			harness.localManifest.setEntry(path, entry);
			harness.api.getManifest.mockResolvedValue({ version: 1, files: { [path]: entry }, lastSeq: 100 });
			harness.api.getChanges.mockResolvedValue({ cursorExpired: true, changes: [], lastSeq: 100, hasMore: false });
			harness.vault.getFiles.mockReturnValue([]);
			harness.vault.adapter.exists.mockResolvedValue(true);
			harness.vault.adapter.list.mockImplementation(async (folder: string) => {
				if (!folder) {
					if (failure === 'root-list') throw new Error('temporary root failure');
					return { files: [], folders: failure === 'nested-list' ? ['notes'] : ['.private'] };
				}
				if (failure === 'hidden-list' || failure === 'nested-list') throw new Error('temporary folder failure');
				return { files: [path], folders: [] };
			});
			harness.vault.adapter.stat.mockRejectedValue(new Error('temporary stat failure'));

			const result = mode === 'force' ? await harness.engine.forceFullSync() : await harness.engine.sync();

			expect(result.success).toBe(false);
			expect(result.errors.join(' ')).toContain('Vault scan incomplete');
			expect(harness.api.deleteFile).not.toHaveBeenCalled();
			expect(harness.api.batchDelete).not.toHaveBeenCalled();
			expect(harness.localManifest.getEntry(path)).toEqual(entry);
			expect(harness.settings.lastSeq).toBe(mode === 'expired-cursor' ? 5 : 0);
			expect(harness.engine.getState().status).toBe('error');
		});
	}

	it.each(['full', 'force'] as const)('%s rechecks a file recreated after discovery before remote deletion', async mode => {
		const harness = createHarness({ lastSeq: 0 });
		harness.localManifest.setEntry(path, entry);
		harness.api.getManifest.mockResolvedValue({ version: 1, files: { [path]: entry }, lastSeq: 100 });
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.adapter.exists.mockResolvedValue(true);
		harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 9, mtime: 2000 });

		const result = mode === 'force' ? await harness.engine.forceFullSync() : await harness.engine.sync();

		expect(result.success).toBe(false);
		expect(result.errors.join(' ')).toContain('Local file exists again');
		expect(harness.api.deleteFile).not.toHaveBeenCalled();
		expect(harness.localManifest.getEntry(path)).toEqual(entry);
	});

	it('incremental deletion reclassifies a recreated file without deleting or advancing its cursor', async () => {
		const harness = createIncrementalHarness({ localDeletes: [path] });
		harness.localManifest.getEntry.mockReturnValue(entry);
		harness.vault.adapter.exists.mockResolvedValue(true);
		harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 9, mtime: 2000 });
		// Reconciliation cannot settle this injected interleaving yet.
		harness.context.reconcileVersionConflicts = async (_paths, result) => { result.errors.push('Retry after local recreation'); };

		const result = await runIncrementalSync(harness.context, { uploadConcurrency: 2 });

		expect(result?.success).toBe(false);
		expect(harness.api.batchDelete).not.toHaveBeenCalled();
		expect(harness.localManifest.removeEntry).not.toHaveBeenCalled();
		expect(harness.settings.lastSeq).toBe(10);
	});

	it('does not reinterpret an adapter existence error as absence', async () => {
		const harness = createHarness();
		harness.vault.adapter.exists.mockRejectedValue(new Error('permission denied'));
		await expect(assertLocalFileAbsent(harness.vault as never, path)).rejects.toThrow('permission denied');
	});

	it('allows replacing a removed local file with a directory', async () => {
		const harness = createHarness();
		harness.vault.adapter.exists.mockResolvedValue(true);
		harness.vault.adapter.stat.mockResolvedValue({ type: 'folder', size: 0, mtime: 2000 });
		await expect(assertLocalFileAbsent(harness.vault as never, path)).resolves.toBeUndefined();
	});
});
