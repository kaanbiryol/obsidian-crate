import { describe, expect, it, vi } from 'vitest';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/test/factories/sync-vault';
import { moveVaultToTrash, replaceVaultBeforeFirstSync } from './vault-replacement';

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

describe('replaceVaultBeforeFirstSync', () => {
	async function replace(settings: { replaceVault: boolean; lastSeq: number }, files: Record<string, unknown> = {}) {
		const disk = await fixture();
		const reportWork = vi.fn();
		const getManifest = vi.fn(() => ({ files }));
		await replaceVaultBeforeFirstSync({
			settings, manifest: { getManifest }, vault: disk.vault, pluginDir: TEST_PLUGIN_DIR, reportWork, throwIfDestroyed: () => {},
		});
		return { disk, reportWork, getManifest };
	}

	it('moves the vault to trash before the first sync and clears the confirmation', async () => {
		const settings = { replaceVault: true, lastSeq: 0 };
		const { disk, reportWork } = await replace(settings);
		expect(disk.has('root.md')).toBe(false);
		expect(disk.trash.has('root.md')).toBe(true);
		expect(reportWork).toHaveBeenCalledExactlyOnceWith({ phase: 'applying' });
		expect(settings.replaceVault).toBe(false);
	});

	it.each([
		{ state: 'a file baseline', lastSeq: 0, files: { 'root.md': { hash: 'a'.repeat(64), size: 7, modified: '2026-10-01T00:00:00.000Z' } } },
		{ state: 'a changelog cursor', lastSeq: 4, files: {} },
	])('keeps the files of a vault with $state but clears the confirmation', async ({ lastSeq, files }) => {
		const settings = { replaceVault: true, lastSeq };
		const { disk, reportWork } = await replace(settings, files);
		expect(disk.trash.size).toBe(0);
		expect(disk.has('root.md')).toBe(true);
		expect(reportWork).not.toHaveBeenCalled();
		expect(settings.replaceVault).toBe(false);
	});

	it('does nothing without a confirmed replacement', async () => {
		const settings = { replaceVault: false, lastSeq: 0 };
		const { disk, reportWork, getManifest } = await replace(settings);
		expect(disk.trash.size).toBe(0);
		expect(disk.has('root.md')).toBe(true);
		expect(reportWork).not.toHaveBeenCalled();
		expect(getManifest).not.toHaveBeenCalled();
	});
});
