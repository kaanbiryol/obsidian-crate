import type { Plugin } from 'obsidian';
import { afterEach } from 'vitest';
import { DEFAULT_SETTINGS, type CrateSettings } from '../../plugin/settings-types';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '../../test/factories/sync-vault';
import { SyncApiClient } from '../worker-api/client';
import { SyncEngine } from './engine';
import { LocalManifest } from '../manifest/manifest';
import { getCheckpointAuthority } from '../connection/worker-url';
import type { ApiHttpTransport } from '../worker-api/http';

const engines = new Set<SyncEngine>();
afterEach(async () => {
	for (const engine of engines) engine.destroy();
	await Promise.all([...engines].map(engine => engine.waitForIdle()));
	engines.clear();
});

/** Keep the engine's actual manifest, journals and file operations bound together. */
export async function createPersistentEngineHarness(transport: ApiHttpTransport, overrides: Partial<CrateSettings> = {}, disk = new PersistentTestVault()) {
	const settings = { ...structuredClone(DEFAULT_SETTINGS), workerUrl: 'https://server.test', syncInterval: 0, ...overrides };
	const api = new SyncApiClient(settings.workerUrl, 'test-token', transport);
	const plugin = {
		manifest: { dir: TEST_PLUGIN_DIR },
		app: { vault: disk.vault, fileManager: {}, workspace: { onLayoutReady: () => {} } },
	} as unknown as Plugin;
	const localManifest = new LocalManifest(plugin.app, plugin.manifest, getCheckpointAuthority(settings) || 'unconfigured');
	const engine = new SyncEngine(plugin, api, settings, { localManifest });
	engines.add(engine);
	await engine.initialize();
	return { disk, engine, api, settings, localManifest, vault: disk.vault };
}
