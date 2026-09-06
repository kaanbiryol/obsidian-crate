import { describe, expect, it, vi } from 'vitest';
import { deletePathLocallyIfUnchanged } from './planner-helpers';
import { computeHash } from './hasher';

	describe('recoverable local deletion', () => {
	it.each(['note.md', 'drawing.canvas', 'image.png', '.hidden/settings.json'])('preserves an edit arriving after the hash check in local trash: %s', async path => {
		const original = new TextEncoder().encode('original').buffer;
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
				getAbstractFileByPath: () => path.startsWith('.') ? null : { path, extension: 'md' },
				adapter: { exists: async () => live !== null, readBinary: async () => live, trashLocal: trash, remove },
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
		const newer = new TextEncoder().encode('late edit').buffer;
		const disk = new Map([[path, original]]);
		const trash = vi.fn(async () => {
			disk.set(`.trash/${path}`, newer);
			disk.delete(path);
			throw new Error('Lost move acknowledgement');
		});
		const context = () => ({ vault: {
			trash,
			getAbstractFileByPath: () => !path.startsWith('.') && disk.has(path) ? { path, extension: 'md' } : null,
			adapter: { exists: async (key: string) => disk.has(key), readBinary: async (key: string) => disk.get(key), trashLocal: trash },
		} as never });
		const expectedHash = await computeHash(original);
		await expect(deletePathLocallyIfUnchanged(context(), path, expectedHash)).rejects.toThrow('Lost move acknowledgement');
		expect(await deletePathLocallyIfUnchanged(context(), path, expectedHash)).toEqual({ status: 'missing' });
		expect(disk.get(`.trash/${path}`)).toEqual(newer);
		expect(trash).toHaveBeenCalledOnce();
	});

	it.each(['note.md', '.hidden/a.md'])('does not fall back to permanent deletion when trash fails: %s', async path => {
		const content = new TextEncoder().encode('original').buffer;
		const remove = vi.fn();
		const trash = async () => { throw new Error('Trash unavailable'); };
		const context = {
			vault: {
				trash,
				getAbstractFileByPath: () => path.startsWith('.') ? null : { path, extension: 'md' },
				adapter: { exists: async () => true, readBinary: async () => content, trashLocal: trash, remove },
			} as never,
			fileManager: { trashFile: vi.fn() },
		};
		await expect(deletePathLocallyIfUnchanged(context, path, await computeHash(content))).rejects.toThrow('Trash unavailable');
		expect(remove).not.toHaveBeenCalled();
		expect(context.fileManager.trashFile).not.toHaveBeenCalled();
	});
});
