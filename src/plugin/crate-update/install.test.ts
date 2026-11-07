import { describe, expect, it } from 'vitest';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '../../test/factories/sync-vault';
import { buildCrateUpdate, crateUpdatePath } from './bundle';
import {
	installCrateUpdate,
	installedCrateVersion,
	listCrateUpdates,
	newerCrateUpdate,
	publishCrateUpdate,
	resumeCrateUpdate,
	type CrateUpdateHost,
} from './install';

const manifest = (version: string) => JSON.stringify({ id: 'crate', name: 'Crate', version, minAppVersion: '1.13.0' });
const release = (version: string) => ({ 'main.js': `main ${version}`, 'styles.css': `styles ${version}`, 'manifest.json': manifest(version) });

function device(version: string) {
	const disk = new PersistentTestVault();
	for (const [name, content] of Object.entries(release(version))) disk.write(`${TEST_PLUGIN_DIR}/${name}`, content);
	disk.write(`${TEST_PLUGIN_DIR}/data.json`, '{"deviceId":"local"}');
	const host: CrateUpdateHost = { adapter: disk.vault.adapter, configDir: '.obsidian', pluginDir: TEST_PLUGIN_DIR };
	return { disk, host };
}

/** Fails the write at `failAt` (1-based), as a crash or full disk would. */
function failingWrites(host: CrateUpdateHost, failAt: number): CrateUpdateHost {
	let writes = 0;
	return { ...host, adapter: { ...host.adapter, write: async (path, data) => {
		if (++writes === failAt) throw new Error('crash');
		return host.adapter.write(path, data);
	} } };
}

describe('crate update install', () => {
	it('publishes the installed release once and removes older bundles', async () => {
		const { disk, host } = device('1.0.0');
		expect(await publishCrateUpdate(host)).toEqual([crateUpdatePath('.obsidian', '1.0.0')]);
		expect(await publishCrateUpdate(host)).toEqual([]);
		for (const [name, content] of Object.entries(release('1.1.0'))) disk.write(`${TEST_PLUGIN_DIR}/${name}`, content);
		expect(await publishCrateUpdate(host)).toEqual([crateUpdatePath('.obsidian', '1.1.0'), crateUpdatePath('.obsidian', '1.0.0')]);
		expect(await listCrateUpdates(host)).toEqual(['1.1.0']);
	});

	it('does not publish over a newer bundle but removes older ones', async () => {
		const { disk, host } = device('1.0.0');
		await disk.vault.adapter.mkdir('.obsidian/crate-update');
		disk.write(crateUpdatePath('.obsidian', '2.0.0'), '{}');
		disk.write(crateUpdatePath('.obsidian', '0.9.0'), '{}');
		expect(await publishCrateUpdate(host)).toEqual([crateUpdatePath('.obsidian', '0.9.0')]);
		expect(await newerCrateUpdate(host)).toBe('2.0.0');
	});

	it('installs every plugin file and leaves local state alone', async () => {
		const { disk, host } = device('1.0.0');
		await installCrateUpdate(host, await buildCrateUpdate(release('1.1.0')));
		expect(await installedCrateVersion(host)).toBe('1.1.0');
		expect(disk.text(`${TEST_PLUGIN_DIR}/main.js`)).toBe('main 1.1.0');
		expect(disk.text(`${TEST_PLUGIN_DIR}/styles.css`)).toBe('styles 1.1.0');
		expect(disk.text(`${TEST_PLUGIN_DIR}/data.json`)).toBe('{"deviceId":"local"}');
		expect(await disk.vault.adapter.exists(`${TEST_PLUGIN_DIR}/.update`)).toBe(false);
	});

	// Writes: 3 staged files, the journal, then styles.css, main.js, manifest.json.
	it.each([1, 2, 3, 4])('discards an install that stopped before its journal (write %i)', async failAt => {
		const { disk, host } = device('1.0.0');
		await expect(installCrateUpdate(failingWrites(host, failAt), await buildCrateUpdate(release('1.1.0')))).rejects.toThrow('crash');
		expect(await resumeCrateUpdate(host)).toBeNull();
		expect(disk.text(`${TEST_PLUGIN_DIR}/main.js`)).toBe('main 1.0.0');
		expect(await installedCrateVersion(host)).toBe('1.0.0');
		expect(await disk.vault.adapter.exists(`${TEST_PLUGIN_DIR}/.update`)).toBe(false);
	});

	it.each([5, 6, 7])('finishes a journaled install on the next start (write %i)', async failAt => {
		const { disk, host } = device('1.0.0');
		await expect(installCrateUpdate(failingWrites(host, failAt), await buildCrateUpdate(release('1.1.0')))).rejects.toThrow('crash');
		expect(await resumeCrateUpdate(host)).toBe('1.1.0');
		for (const [name, content] of Object.entries(release('1.1.0'))) expect(disk.text(`${TEST_PLUGIN_DIR}/${name}`)).toBe(content);
		expect(await disk.vault.adapter.exists(`${TEST_PLUGIN_DIR}/.update`)).toBe(false);
	});

	it('refuses staged files that changed after the journal', async () => {
		const { disk, host } = device('1.0.0');
		await expect(installCrateUpdate(failingWrites(host, 5), await buildCrateUpdate(release('1.1.0')))).rejects.toThrow('crash');
		disk.write(`${TEST_PLUGIN_DIR}/.update/main.js`, 'tampered');
		await expect(resumeCrateUpdate(host)).rejects.toThrow('main.js does not match');
		expect(disk.text(`${TEST_PLUGIN_DIR}/main.js`)).toBe('main 1.0.0');
		expect(await disk.vault.adapter.exists(`${TEST_PLUGIN_DIR}/.update`)).toBe(false);
	});
});
