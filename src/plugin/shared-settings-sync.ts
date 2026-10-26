import { Notice } from 'obsidian';
import type CratePlugin from './CratePlugin';
import { buildSharedSettings, rebaseSharedSettings, sameSharedSettings, saveSharedSettingsChanges } from '../sync/connection/shared-settings';
import { normalizeSharedSettingsValue, type SharedSettings } from '../protocol/shared-settings';
import { createLogger } from '../sync/logger';
import { errorMessage } from '../platform/logger';
import { normalizeIgnorePatterns } from './settings';

const logger = createLogger('SharedSettings');

export const SHARED_SETTINGS_CONFLICT_NOTICE = 'Sync settings changed on another device and were loaded here. Reapply your change if needed.';

type SharedSettingsPlugin = Pick<CratePlugin, 'settings' | 'writeSettings'> & {
	syncRuntime?: Pick<CratePlugin['syncRuntime'], 'getApiClient' | 'updateSyncSettings'>;
};

interface SharedSettingsSync {
	/** The settings tab is open: pulls wait for the push when it closes. */
	observe(): void;
	push(): Promise<void>;
	pull(): Promise<void>;
}

/** Closing settings writes only the shared settings this device changed since it last
 * reconciled them with its server, so it never replaces settings other devices saved.
 * The reconciled settings are saved with plugin data, so a change that could not be saved
 * stays pending for the next close, also after a restart. Pulling adopts other devices'
 * changes while keeping this device's unsaved ones. */
export function createSharedSettingsSync(plugin: SharedSettingsPlugin, configDir = ''): SharedSettingsSync {
	// Local settings always carry this device's own workspace pattern. Compare the server's
	// settings the same way, or every change from another device would read as a conflict.
	const normalize = (settings: SharedSettings): SharedSettings => ({ ...settings, ignorePatterns: normalizeIgnorePatterns(settings.ignorePatterns, configDir) });
	const track = () => {
		const { workerUrl, sharedSettingsBase: saved } = plugin.settings;
		return { workerUrl, base: saved?.workerUrl === workerUrl ? normalize(saved.settings) : buildSharedSettings(plugin.settings) };
	};
	let tracked = track();
	let editing = false;
	let saving = Promise.resolve();

	/** A new server starts from the settings its connection left on this device. */
	const observe = () => {
		if (plugin.settings.workerUrl !== tracked.workerUrl) tracked = track();
	};

	/** Adopts `next` and saves `remote` as the settings last reconciled with the server, in one write. */
	const adopt = async (current: typeof tracked, now: SharedSettings, next: SharedSettings, remote: SharedSettings) => {
		const changed = !sameSharedSettings(next, now);
		const saved = plugin.settings.sharedSettingsBase;
		if (changed || saved?.workerUrl !== current.workerUrl || !sameSharedSettings(saved.settings, remote)) {
			const sharedSettingsBase = { workerUrl: current.workerUrl, settings: remote };
			await plugin.writeSettings(changed ? { ...next, sharedSettingsBase } : { sharedSettingsBase });
		}
		if (changed) plugin.syncRuntime?.updateSyncSettings();
		current.base = remote;
	};

	const push = async () => {
		observe();
		const api = plugin.syncRuntime?.getApiClient();
		const local = buildSharedSettings(plugin.settings);
		if (!api || sameSharedSettings(local, tracked.base)) return;
		const current = tracked;
		const result = await saveSharedSettingsChanges(api, current.base, local, normalize);
		if (tracked !== current || !result.settings) return;
		// Adopt the server's settings, keeping any edit made while saving.
		const now = buildSharedSettings(plugin.settings);
		const next = rebaseSharedSettings(local, now, result.settings);
		if (!next) return;
		await adopt(current, now, next, result.settings);
		if (result.status === 'conflict') new Notice(SHARED_SETTINGS_CONFLICT_NOTICE);
	};

	const pull = async () => {
		observe();
		const api = plugin.syncRuntime?.getApiClient();
		// Open settings would keep showing old values; their push on close reconciles instead.
		if (!api || editing) return;
		const current = tracked;
		const stored = (await api.getSharedSettings()).settings;
		// A locked encrypted vault reads an envelope; there is nothing to adopt yet.
		const readable = stored && normalizeSharedSettingsValue(stored);
		const remote = readable && normalize(readable);
		if (tracked !== current || !remote || editing) return;
		const now = buildSharedSettings(plugin.settings);
		// A setting both devices changed stays local; the next save reports the conflict.
		const next = rebaseSharedSettings(current.base, now, remote);
		if (!next) return;
		await adopt(current, now, next, remote);
	};

	const serialize = (action: () => Promise<void>, failure: string) => {
		saving = saving.then(action).catch(error => { logger.warn(failure, errorMessage(error)); });
		return saving;
	};
	return {
		observe: () => {
			editing = true;
			observe();
		},
		push: () => {
			editing = false;
			return serialize(push, 'Did not save shared settings:');
		},
		pull: () => serialize(pull, 'Did not load shared settings:'),
	};
}

const instances = new WeakMap<CratePlugin, SharedSettingsSync>();

/** One tracker per plugin, shared by the settings tab and the periodic refresh. */
export function sharedSettingsSync(plugin: CratePlugin): SharedSettingsSync {
	let sync = instances.get(plugin);
	if (!sync) {
		sync = createSharedSettingsSync(plugin, plugin.app.vault.configDir);
		instances.set(plugin, sync);
	}
	return sync;
}
