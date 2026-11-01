import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeDocumentFragment } from '../test/factories/obsidian';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '../test/factories/sync-vault';
import { buildCrateUpdate, crateUpdatePath, serializeCrateUpdate, type CrateUpdateBundle } from './crate-update-bundle';
import type { SyncResult } from '../sync/types';

const notices: Array<string | FakeDocumentFragment> = [];
let appVersionSupported = true;

async function load() {
	vi.doMock('obsidian', () => ({
		Notice: class Notice {
			constructor(message: string | FakeDocumentFragment) { notices.push(message); }
			hide(): void {}
		},
		requireApiVersion: () => appVersionSupported,
	}));
	vi.stubGlobal('DocumentFragment', FakeDocumentFragment);
	return import('./crate-update-sync');
}

type Mutable = Omit<CrateUpdateBundle, 'format'> & { format: number };
const manifest = (version: string) => JSON.stringify({ id: 'crate', name: 'Crate', version, minAppVersion: '1.13.0' });
const release = (version: string) => ({ 'main.js': `main ${version}`, 'styles.css': `styles ${version}`, 'manifest.json': manifest(version) });

function setup({ installed = '1.0.0', encrypted = true, enabled = true } = {}) {
	const disk = new PersistentTestVault();
	for (const [name, content] of Object.entries(release(installed))) disk.write(`${TEST_PLUGIN_DIR}/${name}`, content);
	const listeners: Array<(result: SyncResult) => void> = [];
	const plugin = {
		app: { vault: disk.vault },
		manifest: { id: 'crate', dir: TEST_PLUGIN_DIR, version: installed },
		settings: { syncCrateUpdates: enabled, encryptedVaultId: encrypted ? 'vault' : null },
		syncRuntime: {
			isConfigured: () => true,
			waitForStartupSync: vi.fn(async () => true),
			onRawFileChange: vi.fn(),
			addSyncResultListener: (listener: (result: SyncResult) => void) => listeners.push(listener),
			removeSyncResultListener: vi.fn(),
		},
		register: vi.fn(),
	};
	const download = async (version: string, text?: string) => {
		if (!await disk.vault.adapter.exists('.obsidian/crate-update')) await disk.vault.adapter.mkdir('.obsidian/crate-update');
		const path = crateUpdatePath('.obsidian', version);
		disk.write(path, text ?? serializeCrateUpdate(await buildCrateUpdate(release(version))));
		for (const listener of listeners) listener({ downloadedPaths: [path], mergedPaths: [] } as unknown as SyncResult);
	};
	return { disk, plugin, download, mainJs: () => disk.text(`${TEST_PLUGIN_DIR}/main.js`) };
}

afterEach(() => {
	notices.length = 0;
	appVersionSupported = true;
	vi.unstubAllGlobals();
	vi.doUnmock('obsidian');
	vi.resetModules();
});

describe('registerCrateUpdateSync', () => {
	it('publishes the installed release after the startup sync', async () => {
		const { registerCrateUpdateSync } = await load();
		const { disk, plugin } = setup();
		registerCrateUpdateSync(plugin as never, new AbortController().signal, Promise.resolve());
		await vi.waitFor(() => expect(plugin.syncRuntime.onRawFileChange).toHaveBeenCalledWith(crateUpdatePath('.obsidian', '1.0.0')));
		expect(disk.has(crateUpdatePath('.obsidian', '1.0.0'))).toBe(true);
	});

	it('installs a newer release in an encrypted vault and asks for a restart', async () => {
		const { registerCrateUpdateSync } = await load();
		const { plugin, download, mainJs } = setup();
		registerCrateUpdateSync(plugin as never, new AbortController().signal, Promise.resolve());
		await download('1.1.0');
		await vi.waitFor(() => expect(mainJs()).toBe('main 1.1.0'));
		expect(notices).toContain('Crate updated to 1.1.0 from another device. Restart Obsidian to apply it.');
	});

	it('asks before installing without encryption', async () => {
		const { registerCrateUpdateSync } = await load();
		const { plugin, download, mainJs } = setup({ encrypted: false });
		registerCrateUpdateSync(plugin as never, new AbortController().signal, Promise.resolve());
		await download('1.1.0');
		await vi.waitFor(() => expect(notices.some(notice => notice instanceof FakeDocumentFragment)).toBe(true));
		expect(mainJs()).toBe('main 1.0.0');
		(notices.find(notice => notice instanceof FakeDocumentFragment) as FakeDocumentFragment).links[0]!.click();
		await vi.waitFor(() => expect(mainJs()).toBe('main 1.1.0'));
	});

	it('ignores older releases, tampered files and unsupported app versions', async () => {
		const { registerCrateUpdateSync } = await load();
		const { plugin, download, mainJs } = setup({ installed: '1.1.0' });
		registerCrateUpdateSync(plugin as never, new AbortController().signal, Promise.resolve());
		await download('1.0.0');
		const tampered = JSON.parse(serializeCrateUpdate(await buildCrateUpdate(release('1.2.0')))) as Mutable;
		tampered.files['main.js'].content = 'steal()';
		await download('1.2.0', JSON.stringify(tampered));
		await vi.waitFor(() => expect(notices.some(notice => typeof notice === 'string' && notice.includes('could not verify the 1.2.0'))).toBe(true));
		appVersionSupported = false;
		await download('1.3.0');
		await vi.waitFor(() => expect(notices.some(notice => typeof notice === 'string' && notice.includes('needs Obsidian 1.13.0'))).toBe(true));
		expect(mainJs()).toBe('main 1.1.0');
	});

	it('does nothing when the setting is off', async () => {
		const { registerCrateUpdateSync } = await load();
		const { disk, plugin, download, mainJs } = setup({ enabled: false });
		registerCrateUpdateSync(plugin as never, new AbortController().signal, Promise.resolve());
		await download('1.1.0');
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(mainJs()).toBe('main 1.0.0');
		expect(disk.has(crateUpdatePath('.obsidian', '1.0.0'))).toBe(false);
	});
});
