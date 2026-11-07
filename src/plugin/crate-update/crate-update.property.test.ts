import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '../../test/factories/sync-vault';
import { compareVersions, crateUpdateFolder, crateUpdatePath, parseCrateUpdate } from './bundle';
import {
	installCrateUpdate,
	installedCrateVersion,
	newerCrateUpdate,
	publishCrateUpdate,
	type CrateUpdateHost,
} from './install';

const configDir = '.obsidian';
const manifest = (version: string) => JSON.stringify({ id: 'crate', name: 'Crate', version, minAppVersion: '1.13.0' });
const VERSIONS = ['1.0.0', '1.0.1', '1.1.0', '1.10.0', '2.0.0'];

interface Device { disk: PersistentTestVault; host: CrateUpdateHost }

function device(version: string): Device {
	const disk = new PersistentTestVault();
	writeRelease(disk, version);
	return { disk, host: { adapter: disk.vault.adapter, configDir, pluginDir: TEST_PLUGIN_DIR } };
}

function writeRelease(disk: PersistentTestVault, version: string): void {
	disk.write(`${TEST_PLUGIN_DIR}/main.js`, `main ${version}`);
	disk.write(`${TEST_PLUGIN_DIR}/styles.css`, `styles ${version}`);
	disk.write(`${TEST_PLUGIN_DIR}/manifest.json`, manifest(version));
}

/** The vault's update folder as the server holds it. A sync uploads files this device
 * added, deletes files it removed since its last sync, then mirrors the server. */
class Server {
	readonly files = new Map<string, string>();
	private readonly seen = new Map<Device, Set<string>>();
	async sync(current: Device): Promise<void> {
		const { disk } = current;
		const folder = crateUpdateFolder(configDir);
		if (!await disk.vault.adapter.exists(folder)) await disk.vault.adapter.mkdir(folder);
		const local = new Set((await disk.vault.adapter.list(folder)).files);
		const seen = this.seen.get(current) ?? new Set();
		for (const path of seen) if (!local.has(path)) this.files.delete(path);
		for (const path of local) if (!seen.has(path)) this.files.set(path, disk.text(path));
		for (const path of local) if (!this.files.has(path)) disk.remove(path);
		for (const [path, content] of this.files) disk.write(path, content);
		this.seen.set(current, new Set(this.files.keys()));
	}
}

async function installNewer({ host }: Device): Promise<void> {
	const newest = await newerCrateUpdate(host);
	if (newest) await installCrateUpdate(host, await parseCrateUpdate(await host.adapter.read(crateUpdatePath(configDir, newest)), 'crate'));
}

const operation = fc.oneof(
	fc.record({ kind: fc.constant('publish' as const), device: fc.nat(2) }),
	fc.record({ kind: fc.constant('sync' as const), device: fc.nat(2) }),
	fc.record({ kind: fc.constant('install' as const), device: fc.nat(2) }),
	// Obsidian's own updater only moves forward.
	fc.record({ kind: fc.constant('store' as const), device: fc.nat(2), version: fc.constantFrom(...VERSIONS) }),
);

describe('crate update sync', () => {
	it('never downgrades a device and converges on the newest installed release', async () => {
		await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...VERSIONS), { minLength: 3, maxLength: 3 }), fc.array(operation, { maxLength: 25 }), async (start, operations) => {
			const devices = start.map(device);
			const server = new Server();
			let newest = start.reduce((a, b) => compareVersions(a, b) >= 0 ? a : b);
			for (const step of operations) {
				const current = devices[step.device]!;
				const before = await installedCrateVersion(current.host);
				if (step.kind === 'publish') await publishCrateUpdate(current.host);
				if (step.kind === 'sync') await server.sync(current);
				if (step.kind === 'install') await installNewer(current);
				if (step.kind === 'store' && compareVersions(step.version, before) > 0) {
					writeRelease(current.disk, step.version);
					if (compareVersions(step.version, newest) > 0) newest = step.version;
				}
				expect(compareVersions(await installedCrateVersion(current.host), before)).toBeGreaterThanOrEqual(0);
			}
			// Every device starts once and syncs: publish, sync, then install what arrived.
			for (let round = 0; round < 2; round++) {
				for (const current of devices) {
					await publishCrateUpdate(current.host);
					await server.sync(current);
				}
				for (const current of devices) await installNewer(current);
			}
			for (const current of devices) {
				expect(await installedCrateVersion(current.host)).toBe(newest);
				expect(current.disk.text(`${TEST_PLUGIN_DIR}/main.js`)).toBe(`main ${newest}`);
			}
			expect([...server.files.keys()]).toEqual([crateUpdatePath(configDir, newest)]);
		}), { numRuns: 100 });
	});
});
