import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, toArrayBuffer } from './engine-test-harness';
import { computeHash } from './hasher';
import { MarkdownBaseCache } from './markdown-base-cache';

const path = 'note.md';
const base = 'first\nsecond\nthird\n';
const local = 'local\nsecond\nthird\n';
const remote = 'first\nsecond\nremote\n';
const merged = 'local\nsecond\nremote\n';

async function setup(lastSeq: number, initial = local) {
	const h = createHarness({ lastSeq, automaticSync: false });
	let text = initial;
	const file = { path, extension: 'md', stat: { size: toArrayBuffer(text).byteLength, mtime: 2000 } };
	const baseBytes = toArrayBuffer(base);
	const remoteBytes = toArrayBuffer(remote);
	const remoteHash = await computeHash(remoteBytes);
	h.localManifest.setEntry(path, { hash: await computeHash(baseBytes), size: baseBytes.byteLength, modified: new Date(1000).toISOString() });
	vi.spyOn(MarkdownBaseCache.prototype, 'readBase').mockResolvedValue(baseBytes);
	vi.spyOn(MarkdownBaseCache.prototype, 'putBase').mockResolvedValue();
	vi.spyOn(MarkdownBaseCache.prototype, 'pruneUnreferenced').mockResolvedValue();
	h.vault.getFiles.mockReturnValue([file]);
	h.vault.getAbstractFileByPath.mockImplementation(candidate => candidate === path ? file : null);
	h.vault.adapter.exists.mockImplementation(candidate => candidate === path);
	h.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
	h.vault.adapter.readBinary.mockImplementation(() => toArrayBuffer(text));
	const edit = (value: string) => {
		text = value;
		file.stat = { size: toArrayBuffer(text).byteLength, mtime: file.stat.mtime + 1 };
		h.engine.onFileChange(file as never);
	};
	Object.assign(h.vault, { process: vi.fn(async (_file: unknown, update: (value: string) => string) => { edit(update(text)); return text; }) });
	const entry = { hash: remoteHash, size: remoteBytes.byteLength, modified: new Date(3000).toISOString(), revision: 'remote-v2' };
	h.api.getManifest.mockResolvedValue({ version: 1, files: { [path]: entry }, lastSeq: 2 });
	h.api.getChanges.mockResolvedValue({ changes: [{ path, action: 'upload', seq: 2, ...entry, created_at: entry.modified }], lastSeq: 2, hasMore: false });
	h.api.downloadFile.mockResolvedValue({ content: remoteBytes, hash: remoteHash, size: remoteBytes.byteLength, revision: entry.revision });
	h.api.uploadFile.mockImplementation(async (_path, _content, hash) => ({ path, success: true, hash, revision: 'merged-v3' }));
	h.engine.onFileChange(file as never);
	return { ...h, edit, text: () => text };
}

afterEach(() => vi.restoreAllMocks());

describe('pending events from remote application', () => {
	it.each([0, 1])('merges both edits and clears pending in one sync (cursor %i)', async lastSeq => {
		const h = await setup(lastSeq);
		try {
			const result = await h.engine.sync();
			expect(result.errors).toEqual([]);
			expect(result.mergedPaths).toEqual([path]);
			expect(h.text()).toBe(merged);
			expect(h.api.uploadFile.mock.calls[0]?.[1]).toEqual(toArrayBuffer(merged));
			expect(h.engine.getPendingPaths()).toEqual([]);
			expect(h.engine.getState().pendingChanges).toBe(0);
		} finally { h.engine.destroy(); }
	});

	it('clears an already converged file while consuming remote changes', async () => {
		const h = await setup(1, remote);
		try {
			const result = await h.engine.sync();
			expect(result.errors).toEqual([]);
			expect(h.engine.getPendingPaths()).toEqual([]);
			expect(h.api.uploadFile).not.toHaveBeenCalled();
		} finally { h.engine.destroy(); }
	});

	it('clears the event emitted by downloading a remote edit', async () => {
		const h = await setup(1, base);
		try {
			const result = await h.engine.sync();
			expect(result.errors).toEqual([]);
			expect(result.downloadedPaths).toEqual([path]);
			expect(h.text()).toBe(remote);
			expect(h.engine.getPendingPaths()).toEqual([]);
		} finally { h.engine.destroy(); }
	});

	it('retains a genuine edit made after applying the merge', async () => {
		const h = await setup(1);
		try {
			h.localManifest.save.mockImplementationOnce(() => h.edit(`${merged}new edit\n`));
			const result = await h.engine.sync();
			expect(result.errors).toEqual([]);
			expect(h.text()).toBe(`${merged}new edit\n`);
			expect(h.engine.getPendingPaths()).toEqual([path]);
		} finally { h.engine.destroy(); }
	});

	it('retains an edit arriving during the final content verification', async () => {
		const h = await setup(1);
		try {
			h.localManifest.save.mockImplementationOnce(() => {
				h.vault.adapter.readBinary.mockImplementationOnce(() => {
					const snapshot = toArrayBuffer(h.text());
					h.edit(`${merged}new edit\n`);
					return snapshot;
				});
			});
			const result = await h.engine.sync();
			expect(result.errors).toEqual([]);
			expect(h.engine.getPendingPaths()).toEqual([path]);
		} finally { h.engine.destroy(); }
	});
});
