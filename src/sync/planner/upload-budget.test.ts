import { describe, expect, it, vi } from 'vitest';
import { createIncrementalHarness } from './planner-test-harness';
import { runIncrementalSync } from './incremental';

describe('incremental upload budgeting', () => {
	it('retains partial upload results when incremental sync is cancelled', async () => {
		const h = createIncrementalHarness({ localChanges: [{ path: 'a.png', hash: 'hash' }] });
		h.context.prepareUploadFromPath = async path => ({ path, content: new ArrayBuffer(1), size: 1, hash: 'hash' });
		h.context.uploadPreparedFiles = async (_files, result) => {
			result.uploaded = 1;
			result.uploadedPaths.push('saved.md');
			result.errors.push('earlier.md: unreadable');
			throw new DOMException('Cancelled', 'AbortError');
		};
		expect(await runIncrementalSync(h.context, {})).toMatchObject({
			outcome: 'cancelled', success: false, uploaded: 1, uploadedPaths: ['saved.md'], errors: ['earlier.md: unreadable'],
		});
		expect(h.settings.lastSeq).toBe(10);
	});

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
		const result = await runIncrementalSync(h.context, {});
		expect(result?.uploaded).toBe(300);
		expect(events.indexOf('upload')).toBeLessThan(events.indexOf('prepare:299.png'));
	});

	it('stops preparing after cancellation and keeps the remote cursor unchanged', async () => {
		const h = createIncrementalHarness({ localChanges: [{ path: 'a.png', hash: 'hash' }] });
		const cursor = h.settings.lastSeq;
		const upload = vi.spyOn(h.context, 'uploadPreparedFiles');
		const prepare = vi.fn(async () => { throw new DOMException('Cancelled', 'AbortError'); });
		h.context.prepareUploadFromPath = prepare;
		await expect(runIncrementalSync(h.context, {})).resolves.toMatchObject({ outcome: 'cancelled', success: false, errors: [] });
		expect(h.settings.lastSeq).toBe(cursor);
		expect(upload).not.toHaveBeenCalled();
	});
});
