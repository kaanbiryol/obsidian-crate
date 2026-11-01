import { expect, it } from 'vitest';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/test/factories/sync-vault';
import { moveVaultToTrash } from './vault-replacement';

async function fixture() {
	const disk = new PersistentTestVault();
	for (const folder of ['Notes', '.git', '.obsidian/plugins/dataview', '.trash']) await disk.vault.adapter.mkdir(folder);
	for (const path of ['root.md', 'Notes/a.md', '.gitignore', '.git/HEAD', '.obsidian/app.json',
		'.obsidian/plugins/dataview/main.js', `${TEST_PLUGIN_DIR}/data.json`, '.trash/old.md']) disk.write(path, path);
	return disk;
}

it('moves everything except the trash and the Crate plugin folder, including hidden, settings and ignored files', async () => {
	const disk = await fixture();
	await moveVaultToTrash(disk.vault, TEST_PLUGIN_DIR, () => {});
	expect([...disk.trash.keys()].sort()).toEqual(['.git/HEAD', '.gitignore', '.obsidian/app.json',
		'.obsidian/plugins/dataview/main.js', 'Notes/a.md', 'root.md']);
	expect(disk.has(`${TEST_PLUGIN_DIR}/data.json`)).toBe(true);
	expect(disk.has('.trash/old.md')).toBe(true);
	expect((await disk.vault.adapter.list('')).folders.sort()).toEqual(['.obsidian', '.trash']);
});

it('continues with what is left after an interruption', async () => {
	const disk = await fixture();
	let checks = 0;
	await expect(moveVaultToTrash(disk.vault, TEST_PLUGIN_DIR, () => { if (++checks === 3) throw new Error('stopped'); })).rejects.toThrow('stopped');
	expect(disk.has('root.md')).toBe(true);
	await moveVaultToTrash(disk.vault, TEST_PLUGIN_DIR, () => {});
	expect(disk.has('root.md')).toBe(false);
	expect(disk.trash.has('root.md')).toBe(true);
	expect(disk.has(`${TEST_PLUGIN_DIR}/data.json`)).toBe(true);
});
