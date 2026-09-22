import type CratePlugin from '../main';
import type { SyncApiClient } from '../sync/api';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { normalizeRemindersFolderPath } from './settings';
import { createLogger } from './utils/logger';
import { validateReadingFolder } from '../reading/settings';

const logger = createLogger('Reminders');
interface PolicySyncState {
	api: SyncApiClient;
	workerUrl: string;
	signal: AbortSignal;
	confirmedSettings?: string;
	task?: Promise<void>;
}
const states = new WeakMap<CratePlugin, PolicySyncState>();

function policySettings(plugin: CratePlugin) {
	return { enabled: plugin.settings.pushEnabled,
		folderPath: plugin.remindersSettings.remindersFolderPath,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		allDayTime: plugin.remindersSettings.allDayNotificationTime };
}

function pendingFolder(plugin: CratePlugin, workerUrl: string) {
	const pending = plugin.remindersSettings.pendingServerFolder;
	return pending?.workerUrl === workerUrl ? pending : undefined;
}

/** Folder and retry intent share one local save, before any network request. */
export async function changeReminderFolder(plugin: CratePlugin, folderPath: string): Promise<void> {
	const folder = normalizeRemindersFolderPath(folderPath);
	if (plugin.settings.reading?.enabled) validateReadingFolder(plugin.settings.reading.folderPath, folder, plugin.app.vault.configDir);
	await plugin.writeRemindersSettings({ remindersFolderPath: folder,
		pendingServerFolder: plugin.settings.workerUrl
			? { id: crypto.randomUUID(), workerUrl: plugin.settings.workerUrl, folderPath: folder } : undefined });
	void ensureReminderNotificationPolicy(plugin);
	if (plugin.remindersSettings.enabled) await plugin.reinitializeWithFolder(folder);
}

async function synchronizePolicy(plugin: CratePlugin, state: PolicySyncState): Promise<void> {
	const { api, signal, workerUrl } = state;
	const currentConnection = () => states.get(plugin) === state && !signal.aborted && plugin.settings.workerUrl === workerUrl
		&& plugin.syncRuntime.getApiClient() === api;
	do {
		signal.throwIfAborted();
		const settings = policySettings(plugin);
		const settingsKey = JSON.stringify(settings);
		const pending = pendingFolder(plugin, workerUrl);
		if (!pending && state.confirmedSettings === settingsKey) return;
		state.confirmedSettings = undefined;
		const { policy } = await api.ensureNotificationPolicy(settings);
		if (!currentConnection()) return;
		if (pending && plugin.remindersSettings.pendingServerFolder?.id === pending.id) {
			if (policy.folderPath !== pending.folderPath) await api.updateNotificationPolicy({ ...policy, folderPath: pending.folderPath });
			if (!currentConnection()) return;
			// Evaluate inside the write queue so an older response cannot erase a newer edit.
			await plugin.writeRemindersSettings(current => current.pendingServerFolder?.id === pending.id
				? { pendingServerFolder: undefined } : {});
		}
		if (!currentConnection()) return;
		if (!pendingFolder(plugin, workerUrl) && JSON.stringify(policySettings(plugin)) === settingsKey) {
			state.confirmedSettings = settingsKey;
			return;
		}
	} while (currentConnection());
}

export async function ensureReminderNotificationPolicy(plugin: CratePlugin, strict = false): Promise<void> {
	const api = plugin.syncRuntime.getApiClient();
	if (!api) { states.delete(plugin); return; }
	const signal = getPluginLifecycleSignal(plugin);
	const workerUrl = plugin.settings.workerUrl;
	let state = states.get(plugin);
	if (!state || state.api !== api || state.workerUrl !== workerUrl || state.signal !== signal) {
		state = { api, workerUrl, signal };
		states.set(plugin, state);
	}
	const task = state.task ??= synchronizePolicy(plugin, state);
	try { await task; }
	catch (error) {
		if (strict) throw error;
		logger.warn('Reminder settings will retry on the next sync:', error);
		return;
	} finally {
		if (state.task === task) state.task = undefined;
	}
	// A caller joining an older task must also wait for changes made while it ran.
	if (!signal.aborted && (states.get(plugin) !== state || plugin.syncRuntime.getApiClient() !== api
		|| plugin.settings.workerUrl !== workerUrl || pendingFolder(plugin, workerUrl)
		|| state.confirmedSettings !== JSON.stringify(policySettings(plugin)))) {
		await ensureReminderNotificationPolicy(plugin, strict);
	}
}

/** Reconnecting checks the server again, even after an earlier successful confirmation. */
export function refreshReminderNotificationPolicy(plugin: CratePlugin): Promise<void> {
	states.delete(plugin);
	return ensureReminderNotificationPolicy(plugin);
}
