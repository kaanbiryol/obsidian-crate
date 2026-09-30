import { expect, it, vi } from 'vitest';
import type { Vault } from 'obsidian';
import { getAllVaultFiles } from './file-discovery';

it.each(['', '.config', 'notes', 'notes/.config'])('stops discovery after cancelling the listing of %s', async folder => {
	const controller = new AbortController();
	const listings: Record<string, { files: string[]; folders: string[] }> = {
		'': { files: ['.hidden'], folders: ['.config', 'notes'] },
		'.config': { files: ['.config/settings.json'], folders: ['.config/plugins'] },
		'.config/plugins': { files: [], folders: [] },
		'notes': { files: [], folders: ['notes/.config', 'notes/more'] },
		'notes/.config': { files: ['notes/.config/settings.json'], folders: [] },
		'notes/more': { files: [], folders: [] },
	};
	const list = vi.fn(async (path: string) => {
		if (path === folder) controller.abort();
		return listings[path]!;
	});
	const stat = vi.fn(async () => ({ type: 'file', size: 10, mtime: 1 }));
	const vault = { getFiles: () => [], adapter: { list, stat } } as unknown as Vault;

	await expect(getAllVaultFiles(vault, () => false, () => controller.signal.throwIfAborted()))
		.rejects.toMatchObject({ name: 'AbortError' });

	expect(list.mock.lastCall).toEqual([folder]);
	if (folder === '' || folder === '.config') expect(stat).not.toHaveBeenCalled();
	expect(stat).not.toHaveBeenCalledWith('.hidden');
});

it.each(['.hidden', '.config/a.json'])('stops discovery after cancelling the stat of %s', async file => {
	const controller = new AbortController();
	const list = vi.fn(async (path: string) => path === ''
		? { files: file === '.hidden' ? ['.hidden', '.more'] : [], folders: file === '.hidden' ? [] : ['.config'] }
		: { files: ['.config/a.json', '.config/b.json'], folders: ['.config/plugins'] });
	const stat = vi.fn(async () => {
		controller.abort();
		return { type: 'file', size: 10, mtime: 1 };
	});
	const vault = { getFiles: () => [], adapter: { list, stat } } as unknown as Vault;

	await expect(getAllVaultFiles(vault, () => false, () => controller.signal.throwIfAborted()))
		.rejects.toMatchObject({ name: 'AbortError' });

	expect(stat).toHaveBeenCalledExactlyOnceWith(file);
	expect(list).not.toHaveBeenCalledWith('.config/plugins');
});

it('does not touch the vault when discovery is already cancelled', async () => {
	const controller = new AbortController();
	controller.abort();
	const getFiles = vi.fn(() => []);
	const list = vi.fn(async () => ({ files: [], folders: [] }));
	const vault = { getFiles, adapter: { list } } as unknown as Vault;

	await expect(getAllVaultFiles(vault, () => false, () => controller.signal.throwIfAborted()))
		.rejects.toMatchObject({ name: 'AbortError' });

	expect(getFiles).not.toHaveBeenCalled();
	expect(list).not.toHaveBeenCalled();
});
