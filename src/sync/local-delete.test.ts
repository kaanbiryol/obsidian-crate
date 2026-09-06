import { describe, expect, it, vi } from 'vitest';
import { deletePathLocallyIfUnchanged } from './planner-helpers';
import { computeHash } from './hasher';

describe('recoverable local deletion', () => {
	it.each(['note.md', '.hidden/settings.json'])('preserves an edit arriving after the hash check in trash: %s', async path => {
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
				getAbstractFileByPath: () => path.startsWith('.') ? null : { path, extension: 'md' },
				adapter: { exists: async () => live !== null, readBinary: async () => live, trashLocal: trash, remove },
			} as never,
			fileManager: { trashFile: trash },
		};
		expect(await deletePathLocallyIfUnchanged(context, path, await computeHash(original))).toEqual({ status: 'deleted' });
		expect(trashed).toEqual(newer);
		expect(remove).not.toHaveBeenCalled();
	});

	it('does not fall back to permanent deletion when trash fails', async () => {
		const content = new TextEncoder().encode('original').buffer;
		const remove = vi.fn();
		const context = {
			vault: {
				getAbstractFileByPath: () => null,
				adapter: { exists: async () => true, readBinary: async () => content, trashLocal: async () => { throw new Error('Trash unavailable'); }, remove },
			} as never,
			fileManager: { trashFile: vi.fn() },
		};
		await expect(deletePathLocallyIfUnchanged(context, '.hidden/a.md', await computeHash(content))).rejects.toThrow('Trash unavailable');
		expect(remove).not.toHaveBeenCalled();
	});
});
