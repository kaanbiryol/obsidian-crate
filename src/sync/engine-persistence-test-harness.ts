import type { Plugin } from 'obsidian';
import { afterEach, vi } from 'vitest';
import { DEFAULT_SETTINGS, type CrateSettings } from '../plugin/settings-types';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '../test/factories/sync-vault';
import { SyncApiClient } from './api';
import { SyncEngine } from './engine';
import type { LocalManifest } from './manifest';
import type { ApiHttpTransport } from './worker-api/http';

const engines = new Set<SyncEngine>();
afterEach(async () => {
	for (const engine of engines) engine.destroy();
	await Promise.all([...engines].map(engine => engine.waitForIdle()));
	engines.clear();
});

/** Keep the engine's actual manifest, journals and file operations bound together. */
export async function createPersistentEngineHarness(transport: ApiHttpTransport, overrides: Partial<CrateSettings> = {}) {
	const disk = new PersistentTestVault();
	const settings = { ...structuredClone(DEFAULT_SETTINGS), workerUrl: 'https://server.test', syncInterval: 0, ...overrides };
	const api = new SyncApiClient(settings.workerUrl, 'test-token', transport);
	const createFiles = api.createFileOperations.bind(api);
	let localManifest!: LocalManifest;
	vi.spyOn(api, 'createFileOperations').mockImplementation((manifest, vault, cache) => {
		localManifest = manifest;
		return createFiles(manifest, vault, cache);
	});
	const plugin = {
		manifest: { dir: TEST_PLUGIN_DIR },
		app: { vault: disk.vault, fileManager: {}, workspace: { onLayoutReady: () => {} } },
	} as unknown as Plugin;
	const engine = new SyncEngine(plugin, api, settings);
	engines.add(engine);
	await engine.initialize();
	return { disk, engine, api, settings, localManifest, vault: disk.vault };
}
