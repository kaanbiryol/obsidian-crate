import { Notice, requireApiVersion } from 'obsidian';
import type CratePlugin from '../CratePlugin';
import { createLogger } from '../../sync/logger';
import { errorMessage } from '../../platform/logger';
import type { SyncResult } from '../../sync/types';
import { compareVersions, crateUpdatePath, isCrateUpdatePath, parseCrateUpdate, type CrateUpdateBundle } from './bundle';
import {
	installCrateUpdate,
	installedCrateVersion,
	newerCrateUpdate,
	publishCrateUpdate,
	resumeCrateUpdate,
	type CrateUpdateHost,
} from './install';

const logger = createLogger('CrateUpdate');
const RESTART_MESSAGE = (version: string) => `Crate updated to ${version} from another device. Restart Obsidian to apply it.`;

/**
 * Copies Crate releases between this person's devices. A device publishes the release
 * it has installed; another device installs a strictly newer one, never an older one.
 * Encrypted vaults install automatically because only paired devices can write the
 * bundle; otherwise the person confirms first.
 */
export function registerCrateUpdateSync(plugin: CratePlugin, signal: AbortSignal, syncReady: Promise<void>): void {
	const dir = plugin.manifest.dir;
	if (!dir) return;
	const host: CrateUpdateHost = { adapter: plugin.app.vault.adapter, configDir: plugin.app.vault.configDir, pluginDir: dir };
	const offered = new Set<string>();
	let queue: Promise<void> = Promise.resolve();
	const run = (task: () => Promise<void>) => {
		queue = queue.then(() => signal.aborted ? undefined : task()).catch(error => {
			logger.warn('Crate update sync failed:', errorMessage(error));
		});
	};
	const enabled = () => !signal.aborted && plugin.settings.syncCrateUpdates && plugin.syncRuntime.isConfigured();

	const install = async (bundle: CrateUpdateBundle) => {
		// A confirmation can arrive after Obsidian's own updater installed this release or a newer one.
		if (compareVersions(bundle.version, await installedCrateVersion(host)) <= 0) return;
		await installCrateUpdate(host, bundle);
		if (!signal.aborted) new Notice(RESTART_MESSAGE(bundle.version), 15_000);
	};

	const checkForUpdate = async () => {
		if (!enabled()) return;
		const newest = await newerCrateUpdate(host);
		if (!newest || offered.has(newest)) return;
		offered.add(newest);
		let bundle: CrateUpdateBundle;
		try {
			bundle = await parseCrateUpdate(await host.adapter.read(crateUpdatePath(host.configDir, newest)), plugin.manifest.id);
		} catch (error) {
			logger.warn('Rejected Crate update:', errorMessage(error));
			new Notice(`Crate could not verify the ${newest} update from another device. Update Crate in Community plugins instead.`, 15_000);
			return;
		}
		if (!requireApiVersion(bundle.minAppVersion)) {
			new Notice(`Crate ${bundle.version} from another device needs Obsidian ${bundle.minAppVersion} or newer. Update Obsidian first.`, 15_000);
			return;
		}
		if (plugin.settings.encryptedVaultId) { await install(bundle); return; }
		const fragment = new DocumentFragment();
		fragment.createSpan({ text: `Another device installed Crate ${bundle.version}. ` });
		const link = fragment.createEl('a', { text: 'Install update' });
		const notice = new Notice(fragment, 0);
		link.addEventListener('click', () => { notice.hide(); run(() => install(bundle)); });
	};

	const publish = async () => {
		if (!enabled()) return;
		for (const path of await publishCrateUpdate(host)) plugin.syncRuntime.onRawFileChange(path);
	};

	run(async () => {
		const version = await resumeCrateUpdate(host);
		if (version && !signal.aborted && version !== plugin.manifest.version) new Notice(RESTART_MESSAGE(version), 15_000);
	});
	run(async () => {
		await syncReady;
		if (!enabled()) return;
		await plugin.syncRuntime.waitForStartupSync();
		// Install before publishing, so a device never republishes the release it is replacing.
		await checkForUpdate();
		await publish();
	});
	const listener = (result: SyncResult) => {
		if ([...result.downloadedPaths, ...result.mergedPaths].some(path => isCrateUpdatePath(path, host.configDir))) run(checkForUpdate);
	};
	plugin.syncRuntime.addSyncResultListener(listener);
	plugin.register(() => plugin.syncRuntime.removeSyncResultListener(listener));
}
