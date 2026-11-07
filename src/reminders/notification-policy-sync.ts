import type CratePlugin from '../plugin/CratePlugin';
import type { SyncApiClient } from '../sync/worker-api/client';
import type { NotificationPolicy } from '../protocol/notification-policy';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { captureSyncApiConnection } from '../plugin/server-request';
import { cachedSettingsRequest } from '../plugin/settings-ui-state';
import { errorMessage } from '../platform/logger';
import { createLogger } from './logger';

const logger = createLogger('Reminders');
interface PolicySyncState {
	api: SyncApiClient;
	workerUrl: string;
	signal: AbortSignal;
	confirmedSettings?: string;
	task?: Promise<void>;
}
const states = new WeakMap<CratePlugin, PolicySyncState>();

/** The notification policy this device's settings describe. */
export function policySettings(plugin: CratePlugin) {
	return { enabled: plugin.settings.pushEnabled,
		folderPath: plugin.remindersSettings.remindersFolderPath,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		allDayTime: plugin.remindersSettings.allDayNotificationTime };
}

/**
 * Apply an explicit policy edit. Without a known policy, this device's settings
 * create one first. `onPolicy` receives each policy the server returns, so a
 * failed update still keeps the created policy for the next attempt.
 */
export async function saveNotificationPolicy(
	api: Pick<SyncApiClient, 'ensureNotificationPolicy' | 'updateNotificationPolicy'>,
	plugin: CratePlugin,
	current: NotificationPolicy | null,
	patch: Partial<NotificationPolicy>,
	onPolicy: (policy: NotificationPolicy) => void = () => {},
): Promise<NotificationPolicy> {
	let policy = current;
	if (!policy) {
		policy = (await api.ensureNotificationPolicy(policySettings(plugin))).policy;
		onPolicy(policy);
	}
	// Even initialization can race another device. Apply explicit changes using
	// the server's returned revision and retain its timezone and folder.
	policy = (await api.updateNotificationPolicy({ ...policy, ...patch })).policy;
	onPolicy(policy);
	return policy;
}

/** The shared policy as one settings render sees it: read once from the connection
 * captured when it opened, and saved only while that connection is current. */
interface OpenedNotificationPolicy {
	/** The sync client the policy is read from, or null without a connection. */
	readonly api: SyncApiClient | null;
	/** Settles once the first read finishes, whether or not it succeeded. */
	readonly loaded: Promise<void>;
	/** The latest policy read or saved; null before it loads, after a failed read, or when the server has none. */
	readonly policy: NotificationPolicy | null;
	readonly loadError: unknown;
	readonly assertCurrent: () => void;
	save(patch: Partial<NotificationPolicy>): Promise<void>;
}

export function openNotificationPolicy(plugin: CratePlugin): OpenedNotificationPolicy {
	// The policy and the local copy of its settings must come from the same server.
	const { api, assertCurrent } = captureSyncApiConnection(plugin);
	let policy: NotificationPolicy | null = null;
	let loadError: unknown;
	const loaded = api ? cachedNotificationPolicy(plugin, api).then(result => { policy = result; }).catch(error => { loadError = error; }) : Promise.resolve();
	return {
		api, loaded, assertCurrent,
		get policy() { return policy; },
		get loadError() { return loadError; },
		async save(patch) {
			await loaded;
			if (loadError) throw new Error(errorMessage(loadError));
			if (!api) throw new Error('Connect to the sync server before changing notifications');
			assertCurrent();
			try {
				await saveNotificationPolicy(api, plugin, policy, patch, saved => {
					policy = saved;
					plugin.settingsUiState.notificationPolicy = { client: api, folderPath: plugin.remindersSettings.remindersFolderPath, value: Promise.resolve(saved) };
				});
			} catch (error) {
				// Another device may have changed the policy; the next render loads it again.
				plugin.settingsUiState.notificationPolicy = null;
				throw error;
			}
		},
	};
}

/** Settings re-render on every toggle; reuse this connection's policy until the tab closes. */
function cachedNotificationPolicy(plugin: CratePlugin, client: SyncApiClient): Promise<NotificationPolicy | null> {
	return cachedSettingsRequest(plugin.settingsUiState, 'notificationPolicy', { client, folderPath: plugin.remindersSettings.remindersFolderPath },
		() => client.getNotificationPolicy().then(result => result.policy));
}

function pendingFolder(plugin: CratePlugin, workerUrl: string) {
	const pending = plugin.remindersSettings.pendingServerFolder;
	return pending?.workerUrl === workerUrl ? pending : undefined;
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
