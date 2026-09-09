import { describe, expect, it, vi } from 'vitest';
import { deletePathLocallyIfUnchanged } from './planner-helpers';
import { computeHash } from './hasher';
import { TFile, TFolder } from 'obsidian';
import { createTransferHarness, emptyResult } from './transfer-test-harness';
import { processDiff } from './transfer-process';

	describe('recoverable local deletion', () => {
	it.each(['note.md', 'drawing.canvas', 'image.png', '.hidden/settings.json'])('preserves an edit arriving after the hash check in local trash: %s', async path => {
		const original = new TextEncoder().encode('original').buffer;
		const file = { path, extension: 'md' };
		let live: ArrayBuffer | null = original;
		let trashed: ArrayBuffer | null = null;
		const newer = new TextEncoder().encode('newer edit').buffer;
		const trash = vi.fn(async () => {
			// The editor writes after validation, just before the actual move.
			live = newer;
			trashed = live;
			live = null;
		});
		const remove = vi.fn();
		const context = {
			vault: {
				trash,
				getAbstractFileByPath: () => path.startsWith('.') ? null : file,
				adapter: { stat: async () => ({ type: 'file', mtime: 1, ctime: 1, size: 8 }), exists: async () => live !== null, readBinary: async () => live, trashLocal: trash, remove },
			} as never,
			fileManager: { trashFile: vi.fn(async () => { live = null; }) },
		};
		expect(await deletePathLocallyIfUnchanged(context, path, await computeHash(original))).toEqual({ status: 'deleted' });
		expect(trashed).toEqual(newer);
		expect(remove).not.toHaveBeenCalled();
		expect(context.fileManager.trashFile).not.toHaveBeenCalled();
		if (!path.startsWith('.')) expect(trash).toHaveBeenCalledWith(expect.objectContaining({ path }), false);
	});

	it.each(['note.md', '.hidden/a.md'])('retains the moved bytes across a lost trash acknowledgement and retry: %s', async path => {
		const original = new TextEncoder().encode('original').buffer;
		const file = { path, extension: 'md' };
		const newer = new TextEncoder().encode('late edit').buffer;
		const disk = new Map([[path, original]]);
		const trash = vi.fn(async () => {
			disk.set(`.trash/${path}`, newer);
			disk.delete(path);
			throw new Error('Lost move acknowledgement');
		});
		const context = () => ({ vault: {
			trash,
			getAbstractFileByPath: () => !path.startsWith('.') && disk.has(path) ? file : null,
			adapter: { stat: async () => ({ type: 'file', mtime: 1, ctime: 1, size: 8 }), exists: async (key: string) => disk.has(key), readBinary: async (key: string) => disk.get(key), trashLocal: trash },
		} as never });
		const expectedHash = await computeHash(original);
		await expect(deletePathLocallyIfUnchanged(context(), path, expectedHash)).rejects.toThrow('Lost move acknowledgement');
		expect(await deletePathLocallyIfUnchanged(context(), path, expectedHash)).toEqual({ status: 'missing' });
		expect(disk.get(`.trash/${path}`)).toEqual(newer);
		expect(trash).toHaveBeenCalledOnce();
	});

	it.each(['note.md', '.hidden/a.md'])('does not fall back to permanent deletion when trash fails: %s', async path => {
		const content = new TextEncoder().encode('original').buffer;
		const file = { path, extension: 'md' };
		const remove = vi.fn();
		const trash = async () => { throw new Error('Trash unavailable'); };
		const context = {
			vault: {
				trash,
				getAbstractFileByPath: () => path.startsWith('.') ? null : file,
				adapter: { stat: async () => ({ type: 'file', mtime: 1, ctime: 1, size: 8 }), exists: async () => true, readBinary: async () => content, trashLocal: trash, remove },
			} as never,
			fileManager: { trashFile: vi.fn() },
		};
		await expect(deletePathLocallyIfUnchanged(context, path, await computeHash(content))).rejects.toThrow('Trash unavailable');
		expect(remove).not.toHaveBeenCalled();
		expect(context.fileManager.trashFile).not.toHaveBeenCalled();
	});
});

describe('local deletion target replacement', () => {
	it.each(['folder', 'recreated file'] as const)('refuses a %s substituted during the byte read without settling its checkpoint', async replacement => {
		const h = createTransferHarness();
		const path = 'notes/a.md';
		const bytes = new TextEncoder().encode('original').buffer;
		const file = Object.assign(new TFile(), { path, extension: 'md' });
		const next = replacement === 'folder'
			? Object.assign(new TFolder(), { path, children: [Object.assign(new TFile(), { path: `${path}/new.md`, extension: 'md' })] })
			: Object.assign(new TFile(), { path, extension: 'md' });
		h.vault.getAbstractFileByPath.mockReturnValue(file);
		h.adapter.readBinary.mockImplementation(async () => { h.vault.getAbstractFileByPath.mockReturnValue(next); return bytes; });
		const result = emptyResult();
		const localFiles = { [path]: { hash: await computeHash(bytes), size: bytes.byteLength, modified: '2026-09-09T00:00:00.000Z' } };
		await expect(processDiff(h.context, { path, action: 'delete-local', localHash: localFiles[path].hash, cause: 'remote-deleted' }, localFiles, result)).rejects.toThrow('target changed');
		expect(h.vault.trash).not.toHaveBeenCalled();
		expect(h.adapter.remove).not.toHaveBeenCalled();
		expect(h.localManifest.removeEntry).not.toHaveBeenCalled();
		expect(result.deletedPaths).toEqual([]);
		expect(localFiles).toHaveProperty(path);
	});

	it.each(['folder', 'modified file'] as const)('refuses a hidden-path %s substituted after hashing', async replacement => {
		const path = '.hidden/a.md';
		const bytes = new TextEncoder().encode('original').buffer;
		const trashLocal = vi.fn();
		const first = { type: 'file', ctime: 1, mtime: 1, size: bytes.byteLength };
		const second = { ...first, type: replacement === 'folder' ? 'folder' : 'file', mtime: 2 };
		const vault = { getAbstractFileByPath: () => null, adapter: {
			exists: async () => true, readBinary: async () => bytes,
			stat: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second), trashLocal,
		} };
		await expect(deletePathLocallyIfUnchanged({ vault: vault as never }, path, await computeHash(bytes))).rejects.toThrow('target changed');
		expect(trashLocal).not.toHaveBeenCalled();
	});

	it('refuses an already-replaced folder before reading it', async () => {
		const h = createTransferHarness();
		h.vault.getAbstractFileByPath.mockReturnValue(Object.assign(new TFolder(), { path: 'a.md', children: [] }));
		await expect(deletePathLocallyIfUnchanged(h.context, 'a.md', 'old-hash')).rejects.toThrow('target changed');
		expect(h.adapter.readBinary).not.toHaveBeenCalled();
		expect(h.vault.trash).not.toHaveBeenCalled();
	});
});
