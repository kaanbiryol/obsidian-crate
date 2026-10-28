import { describe, expect, it, vi } from 'vitest';
import type { Vault } from 'obsidian';
import { PersistentTestVault } from '../../test/factories/sync-vault';
import { sha256Hex } from '../../platform/sha256';
import { localPathExists } from './stored-name';
import { assertLocalFileAbsent } from './local-absence';
import { readLocalFileEntry } from './local-file-entry';
import { deletePathLocallyIfUnchanged } from './local-delete';

async function renamedDisk(caseInsensitive: boolean, from = 'notes/todo.md', to = 'notes/TODO.md') {
	const disk = new PersistentTestVault({ caseInsensitive });
	await disk.vault.adapter.mkdir('notes');
	disk.write(from, 'Groceries');
	disk.rename(from, to);
	return disk;
}

describe('exact local names after a case-only rename', () => {
	it.each([true, false])('treats the old name as absent and the new name as present (case-insensitive: %s)', async caseInsensitive => {
		const disk = await renamedDisk(caseInsensitive);
		expect(await disk.vault.adapter.exists('notes/todo.md')).toBe(caseInsensitive);
		expect(await localPathExists(disk.vault, 'notes/todo.md')).toBe(false);
		expect(await localPathExists(disk.vault, 'notes/TODO.md')).toBe(true);
		expect(await readLocalFileEntry(disk.vault, 'notes/todo.md')).toBeUndefined();
		await expect(assertLocalFileAbsent(disk.vault, 'notes/todo.md')).resolves.toBeUndefined();
		await expect(assertLocalFileAbsent(disk.vault, 'notes/TODO.md')).rejects.toThrow('Local file exists again');
	});

	it('never deletes the renamed file when the old name is deleted remotely', async () => {
		const disk = await renamedDisk(true);
		const hash = await sha256Hex(disk.read('notes/TODO.md'));
		expect(await deletePathLocallyIfUnchanged({ vault: disk.vault }, 'notes/todo.md', hash)).toEqual({ status: 'missing' });
		expect(disk.paths()).toEqual(['notes/TODO.md']);
		expect(disk.trash.size).toBe(0);
	});

	it('treats a Unicode-normalization-only rename like a case-only one', async () => {
		const disk = await renamedDisk(true, 'notes/caf\u00e9.md', 'notes/cafe\u0301.md');
		expect(await localPathExists(disk.vault, 'notes/caf\u00e9.md')).toBe(false);
		expect(await localPathExists(disk.vault, 'notes/cafe\u0301.md')).toBe(true);
	});

	it('keeps files inside a folder stored under another spelling', async () => {
		const disk = await renamedDisk(true);
		expect(await localPathExists(disk.vault, 'Notes/TODO.md')).toBe(true);
		expect(await localPathExists(disk.vault, 'Notes/todo.md')).toBe(false);
	});

	it('keeps the adapter answer when the listing cannot prove a variant replaced the name', async () => {
		const exists = vi.fn(async () => true);
		const vault = (list: () => Promise<{ files: string[]; folders: string[] }>) => ({
			getAbstractFileByPath: () => null, adapter: { exists, list },
		}) as unknown as Vault;
		expect(await localPathExists(vault(async () => { throw new Error('EACCES'); }), 'notes/todo.md')).toBe(true);
		expect(await localPathExists(vault(async () => ({ files: [], folders: [] })), 'notes/todo.md')).toBe(true);
		expect(await localPathExists(vault(async () => ({ files: ['notes/TODO.md'], folders: [] })), 'notes/todo.md')).toBe(false);
	});

	it('trusts the vault index without listing the folder', async () => {
		const list = vi.fn();
		const vault = { getAbstractFileByPath: () => ({ path: 'todo.md' }), adapter: { exists: async () => true, list } } as unknown as Vault;
		expect(await localPathExists(vault, 'todo.md')).toBe(true);
		expect(list).not.toHaveBeenCalled();
	});
});
