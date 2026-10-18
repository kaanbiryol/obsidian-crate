import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, toArrayBuffer } from './engine-test-harness';
import { computeHash } from './hasher';
import { arrayBufferToBase64 } from './encoding';
import { VERIFICATION_FILE_BUDGET } from './content-verifier';
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
	h.vault.adapter.readBinary.mockImplementation(async () => toArrayBuffer(text));
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
			h.localManifest.save.mockImplementationOnce(async () => h.edit(`${merged}new edit\n`));
			const result = await h.engine.sync();
			expect(result.errors).toEqual([]);
			expect(h.text()).toBe(`${merged}new edit\n`);
			expect(h.engine.getPendingPaths()).toEqual([path]);
		} finally { h.engine.destroy(); }
	});

	it('retains an edit arriving during the final content verification', async () => {
		const h = await setup(1);
		try {
			h.localManifest.save.mockImplementationOnce(async () => {
				// The final check compares metadata recorded when the merge was applied.
				const stat = h.vault.adapter.stat.getMockImplementation()!;
				h.vault.adapter.stat.mockImplementationOnce(async candidate => {
					const snapshot = await stat(candidate);
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

describe('downloaded file verification cost', () => {
	it('settles events from downloaded files without rereading them', async () => {
		const h = createHarness({ lastSeq: 1, automaticSync: false });
		const baseBytes = toArrayBuffer(base);
		const remoteBytes = toArrayBuffer(remote);
		const remoteHash = await computeHash(remoteBytes);
		vi.spyOn(MarkdownBaseCache.prototype, 'putBase').mockResolvedValue();
		vi.spyOn(MarkdownBaseCache.prototype, 'pruneUnreferenced').mockResolvedValue();
		type TestFile = { path: string; extension: string; text: string; stat: { size: number; mtime: number } };
		const files = new Map<string, TestFile>(Array.from({ length: 50 }, (_, i) => {
			const filePath = `notes/${i}.md`;
			return [filePath, { path: filePath, extension: 'md', text: base, stat: { size: baseBytes.byteLength, mtime: 1000 } }];
		}));
		for (const file of files.values()) {
			h.localManifest.setEntry(file.path, { hash: await computeHash(baseBytes), size: baseBytes.byteLength, modified: new Date(1000).toISOString() });
		}
		h.vault.getFiles.mockImplementation(() => [...files.values()]);
		h.vault.getAbstractFileByPath.mockImplementation((candidate: string) => files.get(candidate) ?? null);
		h.vault.adapter.exists.mockImplementation((candidate: string) => files.has(candidate));
		h.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		h.vault.adapter.readBinary.mockImplementation(async (candidate: string) => toArrayBuffer(files.get(candidate)!.text));
		Object.assign(h.vault, { process: vi.fn(async (file: { path: string }, update: (value: string) => string) => {
			const current = files.get(file.path)!;
			current.text = update(current.text);
			current.stat = { size: toArrayBuffer(current.text).byteLength, mtime: current.stat.mtime + 1 };
			h.engine.onFileChange(current as never);
			return current.text;
		}) });
		h.api.getChanges.mockResolvedValue({
			changes: [...files.keys()].map((filePath, i) => ({ path: filePath, action: 'upload', seq: i + 2, hash: remoteHash, size: remoteBytes.byteLength, revision: 'remote-v2', created_at: new Date(3000).toISOString() })),
			lastSeq: 51, hasMore: false,
		});
		h.api.batchDownload.mockImplementation(async (paths: string[]) => ({
			files: paths.map(filePath => ({ path: filePath, content: arrayBufferToBase64(remoteBytes), hash: remoteHash, size: remoteBytes.byteLength, revision: 'remote-v2' })),
		}));
		try {
			const result = await h.engine.sync();
			await h.engine.waitForIdle();
			expect(result.errors).toEqual([]);
			expect(result.downloadedPaths).toHaveLength(50);
			expect(h.engine.getPendingPaths()).toEqual([]);
			// Per file: reconciliation, the pre-write check and post-write verification,
			// plus one rotating content check. Settling events no longer rereads (was 4 per file).
			const reads = h.vault.adapter.readBinary.mock.calls.filter(([candidate]) => candidate.startsWith('notes/'));
			expect(reads).toHaveLength(50 * 3 + VERIFICATION_FILE_BUDGET);
		} finally { h.engine.destroy(); }
	});
});
