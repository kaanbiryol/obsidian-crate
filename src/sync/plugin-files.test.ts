import { describe, expect, it } from 'vitest';
import { createHarness, toArrayBuffer } from './engine-test-harness';

const configDir = '.vault-config';
const pluginsDir = `${configDir}/plugins`;

function pluginHarness(pluginId: string, file: string, ignorePatterns: string[] = []) {
	const harness = createHarness({ ignorePatterns });
	const directory = `${pluginsDir}/${pluginId}`;
	const path = `${directory}/${file}`;
	harness.vault.getFiles.mockReturnValue([]);
	harness.vault.adapter.list.mockImplementation(async folder => {
		if (!folder) return { files: [], folders: [configDir] };
		if (folder === configDir) return { files: [], folders: [pluginsDir] };
		if (folder === pluginsDir) return { files: [], folders: [directory] };
		if (folder === directory) return { files: [path], folders: [] };
		return { files: [], folders: [] };
	});
	harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 4, mtime: 2000 });
	harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('test'));
	return { ...harness, path, directory };
}

describe('plugin file sync scope', () => {
	it.each(['main.js', 'manifest.json', 'styles.css', 'data.json'])('detects a plugin %s without a vault event', async file => {
		const harness = pluginHarness('other-plugin', file);
		await expect(harness.engine.hasUnsyncedLocalChanges()).resolves.toBe(true);
		harness.localManifest.setEntry(harness.path, { hash: 'old', size: 3, modified: new Date(1000).toISOString() });
		await expect(harness.engine.hasUnsyncedLocalChanges()).resolves.toBe(true);
	});

	it.each(['main.js', 'data.json', 'file-manifest.json'])('does not scan Crate’s %s', async file => {
		const harness = pluginHarness('crate', file);
		await expect(harness.engine.hasUnsyncedLocalChanges()).resolves.toBe(false);
		expect(harness.vault.adapter.list).not.toHaveBeenCalledWith(harness.directory);
	});

	it('respects a user exclusion for another plugin', async () => {
		const harness = pluginHarness('other-plugin', 'data.json', [`${pluginsDir}/other-plugin/`]);
		await expect(harness.engine.hasUnsyncedLocalChanges()).resolves.toBe(false);
		expect(harness.vault.adapter.list).not.toHaveBeenCalledWith(harness.directory);
	});

	it('keeps other plugins out of ignored remote cleanup', async () => {
		const harness = createHarness();
		const entry = { hash: 'hash', size: 4, modified: new Date(1000).toISOString() };
		harness.api.getManifest.mockResolvedValue({ version: 1, files: {
			[`${pluginsDir}/other-plugin/main.js`]: entry,
			[`${pluginsDir}/other-plugin/data.json`]: entry,
			[`${pluginsDir}/crate/data.json`]: entry,
		} });
		await expect(harness.engine.previewIgnoredRemoteFiles()).resolves.toEqual([`${pluginsDir}/crate/data.json`]);
	});
});
