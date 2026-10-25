import { Notice } from 'obsidian';
import type CratePlugin from './CratePlugin';
import { buildSharedSettings, rebaseSharedSettings, sameSharedSettings, saveSharedSettingsChanges } from '../sync/connection/shared-settings';
import { normalizeSharedSettingsValue } from '../protocol/shared-settings';
import { createLogger } from '../sync/logger';
import { errorMessage } from '../platform/logger';

const logger = createLogger('SharedSettings');

export const SHARED_SETTINGS_CONFLICT_NOTICE = 'Sync settings changed on another device and were loaded here. Reapply your change if needed.';

type SharedSettingsPlugin = Pick<CratePlugin, 'settings' | 'writeSettings'> & {
	syncRuntime?: Pick<CratePlugin['syncRuntime'], 'getApiClient' | 'updateSyncSettings'>;
};

interface SharedSettingsSync { observe(): void; push(): Promise<void>; pull(): Promise<void> }

/** Closing settings writes only the shared settings this device changed since it last
 * reconciled them with its server, so it never replaces settings other devices saved.
 * A change that could not be saved stays pending for the next close. Pulling adopts
 * other devices' changes while keeping this device's unsaved ones. */
export function createSharedSettingsSync(plugin: SharedSettingsPlugin): SharedSettingsSync {
	const track = () => ({ workerUrl: plugin.settings.workerUrl, base: buildSharedSettings(plugin.settings) });
	let tracked = track();
	let saving = Promise.resolve();

	/** A new server starts from the settings its connection left on this device. */
	const observe = () => {
		if (plugin.settings.workerUrl !== tracked.workerUrl) tracked = track();
	};

	const push = async () => {
		observe();
		const api = plugin.syncRuntime?.getApiClient();
		const local = buildSharedSettings(plugin.settings);
		if (!api || sameSharedSettings(local, tracked.base)) return;
		const current = tracked;
		const result = await saveSharedSettingsChanges(api, current.base, local);
		if (tracked !== current || !result.settings) return;
		// Adopt the server's settings, keeping any edit made while saving.
		const now = buildSharedSettings(plugin.settings);
		const next = rebaseSharedSettings(local, now, result.settings);
		if (!next) return;
		if (!sameSharedSettings(next, now)) {
			await plugin.writeSettings(next);
			plugin.syncRuntime?.updateSyncSettings();
		}
		current.base = result.settings;
		if (result.status === 'conflict') new Notice(SHARED_SETTINGS_CONFLICT_NOTICE);
	};

	const pull = async () => {
		observe();
		const api = plugin.syncRuntime?.getApiClient();
		if (!api) return;
		const current = tracked;
		const stored = (await api.getSharedSettings()).settings;
		// A locked encrypted vault reads an envelope; there is nothing to adopt yet.
		const remote = stored && normalizeSharedSettingsValue(stored);
		if (tracked !== current || !remote) return;
		const now = buildSharedSettings(plugin.settings);
		// A setting both devices changed stays local; the next save reports the conflict.
		const next = rebaseSharedSettings(current.base, now, remote);
		if (!next) return;
		if (!sameSharedSettings(next, now)) {
			await plugin.writeSettings(next);
			plugin.syncRuntime?.updateSyncSettings();
		}
		current.base = remote;
	};

	const serialize = (action: () => Promise<void>, failure: string) => {
		saving = saving.then(action).catch(error => { logger.warn(failure, errorMessage(error)); });
		return saving;
	};
	return {
		observe,
		push: () => serialize(push, 'Did not save shared settings:'),
		pull: () => serialize(pull, 'Did not load shared settings:'),
	};
}

const instances = new WeakMap<CratePlugin, SharedSettingsSync>();

/** One tracker per plugin, shared by the settings tab and the periodic refresh. */
export function sharedSettingsSync(plugin: CratePlugin): SharedSettingsSync {
	let sync = instances.get(plugin);
	if (!sync) {
		sync = createSharedSettingsSync(plugin);
		instances.set(plugin, sync);
	}
	return sync;
}
