import { describe, expect, it, vi } from 'vitest';
import { createIncrementalHarness } from './planner-test-harness';
import { runIncrementalSync } from './planner-incremental';

describe('incremental upload budgeting', () => {
	it('uploads bounded chunks before preparing the rest of the changed files', async () => {
		const h = createIncrementalHarness({
			localChanges: Array.from({ length: 300 }, (_, index) => ({ path: `${index}.png`, hash: 'hash' })),
		});
		const events: string[] = [];
		h.context.prepareUploadFromPath = async path => {
			events.push(`prepare:${path}`);
			return { path, content: new ArrayBuffer(1), size: 1, hash: 'hash', mtime: 1 };
		};
		h.context.uploadPreparedFiles = async (files, result) => {
			expect(files.length).toBeLessThanOrEqual(128);
			events.push('upload');
			result.uploaded += files.length;
		};
		const result = await runIncrementalSync(h.context, { uploadConcurrency: 2 });
		expect(result?.uploaded).toBe(300);
		expect(events.indexOf('upload')).toBeLessThan(events.indexOf('prepare:299.png'));
	});

	it('stops preparing after cancellation and keeps the remote cursor unchanged', async () => {
		const h = createIncrementalHarness({ localChanges: [{ path: 'a.png', hash: 'hash' }] });
		const cursor = h.settings.lastSeq;
		const upload = vi.spyOn(h.context, 'uploadPreparedFiles');
		const prepare = vi.fn(async () => { throw new DOMException('Cancelled', 'AbortError'); });
		h.context.prepareUploadFromPath = prepare;
		await expect(runIncrementalSync(h.context, { uploadConcurrency: 2 })).rejects.toMatchObject({ name: 'AbortError' });
		expect(h.settings.lastSeq).toBe(cursor);
		expect(upload).not.toHaveBeenCalled();
	});
});
