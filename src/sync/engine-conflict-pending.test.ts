import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, toArrayBuffer } from './engine-test-harness';
import { computeHash } from './hasher';

const configPaths = ['app', 'appearance', 'community-plugins', 'core-plugins']
	.map(name => `.vault-config/${name}.json`);
const localText = '{"device":"b"}';
const remoteText = '{"device":"a"}';

async function setup(lastSeq = 0) {
	const h = createHarness({ lastSeq, lastSync: '2026-10-01T00:00:00Z', automaticSync: false });
	const files = new Map(configPaths.map(path => [path, toArrayBuffer(localText)]));
	let mtime = 1000;
	h.vault.getFiles.mockReturnValue([]);
	h.vault.getAbstractFileByPath.mockReturnValue(null);
	h.vault.adapter.exists.mockImplementation((path: string) => files.has(path) || path === '.vault-config');
	h.vault.adapter.stat.mockImplementation(async path => {
		const content = files.get(path);
		if (content) return { type: 'file', size: content.byteLength, mtime };
		return path === '.vault-config' ? { type: 'folder', size: 0, mtime } : null;
	});
	h.vault.adapter.list.mockImplementation(async path => path === ''
		? { files: [], folders: ['.vault-config'] }
		: { files: [...files.keys()].filter(file => file.startsWith(`${path}/`)), folders: [] });
	h.vault.adapter.readBinary.mockImplementation((path: string) => {
		const content = files.get(path);
		if (!content) throw new Error(`Missing file: ${path}`);
		return content;
	});
	h.vault.adapter.read.mockImplementation((path: string) => new TextDecoder().decode(files.get(path)));
	h.vault.adapter.write.mockImplementation((path: string, text: string) => { files.set(path, toArrayBuffer(text)); });
	h.vault.adapter.remove.mockImplementation((path: string) => { files.delete(path); });
	const edit = async (path: string, text: string) => {
		files.set(path, toArrayBuffer(text));
		mtime++;
		await h.engine.onRawFileChange(path);
	};
	Object.assign(h.vault.adapter, {
		process: vi.fn(async (path: string, update: (text: string) => string) => {
			const text = update(new TextDecoder().decode(files.get(path)));
			await edit(path, text);
			return text;
		}),
	});
	h.vault.createBinary = vi.fn(async (path: string, content: ArrayBuffer) => {
		if (files.has(path)) throw new Error('File already exists');
		files.set(path, content);
		await h.engine.onRawFileChange(path);
	});
	const content = toArrayBuffer(remoteText);
	const entry = { hash: await computeHash(content), size: content.byteLength, modified: new Date(2000).toISOString(), revision: 'remote-v1' };
	h.api.getManifest.mockResolvedValue({ version: 1, files: Object.fromEntries(configPaths.map(path => [path, entry])), lastSeq: 5 });
	h.api.getChanges.mockResolvedValue({ changes: configPaths.map((path, i) => ({ path, action: 'upload', seq: i + 2, ...entry, created_at: entry.modified })), lastSeq: 5, hasMore: false });
	h.api.downloadFile.mockResolvedValue({ content, ...entry });
	return { ...h, files, edit, remoteHash: entry.hash };
}

afterEach(() => vi.restoreAllMocks());

it.each([0, 1])('clears pending settings after preserving conflicts in an established vault (cursor %i)', async lastSeq => {
	const h = await setup(lastSeq);
	try {
		for (const path of configPaths) await h.engine.onRawFileChange(path);
		const result = await h.engine.sync();
		expect(result.errors).toEqual([]);
		expect(result.unresolvedConflicts).toHaveLength(4);
		for (const path of configPaths) {
			expect(h.files.get(path)).toEqual(toArrayBuffer(remoteText));
			expect(h.localManifest.getEntry(path)?.hash).toBe(h.remoteHash);
			const conflict = h.engine.getActiveConflicts().find(record => record.originalPath === path)!;
			expect(conflict).toMatchObject({ cause: 'concurrent-create', status: 'active' });
			expect(h.files.get(conflict.conflictPath)).toEqual(toArrayBuffer(localText));
		}
		expect(h.api.uploadFile).not.toHaveBeenCalled();
		expect(h.api.batchUpload).not.toHaveBeenCalled();
		expect(h.engine.getPendingPaths()).toEqual([]);
		expect(h.engine.getState()).toMatchObject({ pendingChanges: 0, conflictCount: 4 });
	} finally { h.engine.destroy(); }
});

it('retains a settings edit made after applying the server version', async () => {
	const h = await setup();
	const path = configPaths[1]!;
	const edited = '{"device":"b","newEdit":true}';
	try {
		h.localManifest.save = vi.fn(async () => { await h.edit(path, edited); });
		const result = await h.engine.sync();
		expect(result.errors).toEqual([]);
		expect(h.files.get(path)).toEqual(toArrayBuffer(edited));
		expect(h.localManifest.getEntry(path)?.hash).toBe(h.remoteHash);
		expect(h.engine.getPendingPaths()).toEqual([path]);
		expect(h.engine.getState()).toMatchObject({ pendingChanges: 1, conflictCount: 4 });
	} finally { h.engine.destroy(); }
});

it('retains a settings event arriving during final content verification', async () => {
	const h = await setup();
	const path = configPaths[1]!;
	try {
		h.localManifest.save.mockImplementationOnce(() => {
			h.vault.adapter.readBinary = vi.fn(async (candidate: string) => {
				const content = h.files.get(candidate);
				if (!content) throw new Error(`Missing file: ${candidate}`);
				if (candidate === path) await h.edit(path, remoteText);
				return content;
			});
		});
		const result = await h.engine.sync();
		expect(result.errors).toEqual([]);
		expect(h.engine.getPendingPaths()).toEqual([path]);
		expect(h.engine.getState().conflictCount).toBe(4);
	} finally { h.engine.destroy(); }
});
