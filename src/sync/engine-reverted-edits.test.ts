import { describe, expect, it } from 'vitest';
import { computeHash } from './hasher';
import { createHarness, toArrayBuffer } from './engine-test-harness';

async function revertedEdit(lastSeq: number, mtime = 2000) {
	const h = createHarness({ lastSeq, automaticSync: false });
	const path = 'note.md';
	const content = toArrayBuffer('original');
	const entry = { hash: await computeHash(content), size: content.byteLength, modified: new Date(1000).toISOString() };
	h.localManifest.setEntry(path, entry);
	h.vault.getFiles.mockReturnValue([{ path, extension: 'md', stat: { size: content.byteLength, mtime } }]);
	h.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
	h.vault.adapter.exists.mockImplementation((candidate: string) => candidate === path);
	h.vault.adapter.readBinary.mockResolvedValue(content);
	h.api.getChanges.mockResolvedValue({ changes: [], lastSeq: 1, hasMore: false });
	h.api.getManifest.mockResolvedValue({ version: 1, files: { [path]: entry }, lastSeq: 1 });
	h.engine.onFileChange({ path } as never);
	return { h, path, content };
}

describe('reverted edits', () => {
	it.each([0, 1])('clears a reverted edit without transferring files (cursor %i)', async lastSeq => {
		const { h, path } = await revertedEdit(lastSeq);
		try {
			expect(h.engine.getState().pendingChanges).toBe(1);
			const result = await h.engine.sync();
			expect(result.success).toBe(true);
			expect(result.settledPaths).toContain(path);
			expect(h.engine.getPendingPaths()).toEqual([]);
			expect(h.engine.getState().pendingChanges).toBe(0);
			expect(h.api.uploadFile).not.toHaveBeenCalled();
			expect(h.api.batchUpload).not.toHaveBeenCalled();
			expect(h.api.batchDownload).not.toHaveBeenCalled();
			expect(h.localManifest.getEntry(path)?.modified).toBe(new Date(2000).toISOString());
			expect(h.localManifest.save).toHaveBeenCalled();
		} finally { h.engine.destroy(); }
	});

	it('rechecks a queued file even when its timestamp already matches the manifest', async () => {
		const { h, path } = await revertedEdit(1, 1000);
		try {
			const result = await h.engine.sync();
			expect(result.settledPaths).toContain(path);
			expect(h.engine.getPendingPaths()).toEqual([]);
		} finally { h.engine.destroy(); }
	});

	it.each([0, 1])('preserves edits arriving after the scan (cursor %i)', async lastSeq => {
		const { h, path } = await revertedEdit(lastSeq);
		try {
			h.localManifest.save.mockImplementationOnce(() => {
				h.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('new edit'));
				h.engine.onFileChange({ path } as never);
			});
			const result = await h.engine.sync();
			expect(result.success).toBe(true);
			expect(result.settledPaths).toContain(path);
			expect(h.engine.getPendingPaths()).toEqual([path]);
			expect(h.engine.getState().pendingChanges).toBe(1);
		} finally { h.engine.destroy(); }
	});
});
