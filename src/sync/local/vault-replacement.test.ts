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
	await moveVaultToTrash(disk.vault, TEST_PLUGIN_DIR, new AbortController().signal);
	expect([...disk.trash.keys()].sort()).toEqual(['.git/HEAD', '.gitignore', '.obsidian/app.json',
		'.obsidian/plugins/dataview/main.js', 'Notes/a.md', 'root.md']);
	expect(disk.has(`${TEST_PLUGIN_DIR}/data.json`)).toBe(true);
	expect(disk.has('.trash/old.md')).toBe(true);
	expect((await disk.vault.adapter.list('')).folders.sort()).toEqual(['.obsidian', '.trash']);
});

it('continues with what is left after an interruption', async () => {
	const disk = await fixture();
	// Stop after the first entry moves, so the next check throws.
	const controller = new AbortController();
	const lookup = disk.vault.getAbstractFileByPath.bind(disk.vault);
	vi.spyOn(disk.vault, 'getAbstractFileByPath').mockImplementationOnce(path => {
		controller.abort(new Error('stopped'));
		return lookup(path);
	});
	await expect(moveVaultToTrash(disk.vault, TEST_PLUGIN_DIR, controller.signal)).rejects.toThrow('stopped');
	expect(disk.has('root.md')).toBe(true);
	await moveVaultToTrash(disk.vault, TEST_PLUGIN_DIR, new AbortController().signal);
	expect(disk.has('root.md')).toBe(false);
	expect(disk.trash.has('root.md')).toBe(true);
	expect(disk.has(`${TEST_PLUGIN_DIR}/data.json`)).toBe(true);
});

describe('replaceVaultBeforeFirstSync', () => {
	async function replace(settings: { replaceVault: boolean; lastSeq: number }, files: Record<string, unknown> = {}) {
		const disk = await fixture();
		const reportWork = vi.fn();
		const getManifest = vi.fn(() => ({ files }));
		// What a save writes: a restart after it must not move the vault again.
		const saved: boolean[] = [];
		const saveSettings = vi.fn(async () => { saved.push(settings.replaceVault); });
		await replaceVaultBeforeFirstSync({
			settings, manifest: { getManifest }, vault: disk.vault, pluginDir: TEST_PLUGIN_DIR, reportWork, saveSettings, signal: new AbortController().signal,
		});
		return { disk, reportWork, getManifest, saveSettings, saved };
	}

	it('moves the vault to trash before the first sync and clears the confirmation', async () => {
		const settings = { replaceVault: true, lastSeq: 0 };
		const { disk, reportWork, saved } = await replace(settings);
		expect(disk.has('root.md')).toBe(false);
		expect(disk.trash.has('root.md')).toBe(true);
		expect(reportWork).toHaveBeenCalledExactlyOnceWith({ phase: 'applying' });
		expect(settings.replaceVault).toBe(false);
		// Saved before the sync goes on, so notes made during it are never trashed by a restart.
		expect(saved).toEqual([false]);
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
		const { disk, reportWork, getManifest, saveSettings } = await replace(settings);
		expect(disk.trash.size).toBe(0);
		expect(disk.has('root.md')).toBe(true);
		expect(reportWork).not.toHaveBeenCalled();
		expect(getManifest).not.toHaveBeenCalled();
		expect(saveSettings).not.toHaveBeenCalled();
	});
});
