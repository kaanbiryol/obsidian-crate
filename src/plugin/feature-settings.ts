import { Notice } from 'obsidian';
import type CratePlugin from './CratePlugin';
import type { SyncState } from '../sync/types';
import { captureServerConnection, serverRequest } from './server-request';
import { restartReading } from '../reading/runtime';
import { readReadingPolicy } from '../reading/server';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { parseFeaturePolicy, type FeaturePolicy, type SharedFeatures } from '../protocol/feature-policy';
import { sharedSettingsSync } from './shared-settings-sync';
import { openConfirmationModal } from '../ui/confirmation-modal';

type Feature = keyof SharedFeatures;

/** Whether this vault agreed to let Crate change notes in the feature's folder. */
function featureConfirmed(plugin: CratePlugin, feature: Feature): boolean {
	return feature === 'reading' ? plugin.settings.reading.confirmed : plugin.remindersSettings.confirmed;
}

const CONFIRMATIONS: Record<Feature, { title: string; message: (folder: string) => string }> = {
	reading: { title: 'Turn on reading', message: folder => `Crate will add reading properties to every Markdown note in "${folder}". Notes outside this folder are not changed.` },
	reminders: { title: 'Turn on reminders', message: folder => `Crate will add hidden tracking IDs to checkbox lines in "${folder}" and turn dates like "tomorrow" into real dates. Notes outside this folder are not changed.` },
};

/** Before a feature first changes notes in this vault, asks with the folder it will use.
 * Connected, Reading uses the folder its server names. */
export async function confirmFeatureFolder(plugin: CratePlugin, feature: Feature): Promise<boolean> {
	if (featureConfirmed(plugin, feature)) return true;
	let folder = feature === 'reading' ? plugin.settings.reading.folderPath : plugin.remindersSettings.remindersFolderPath;
	if (feature === 'reading' && plugin.settings.workerUrl) {
		const { assertCurrent } = captureServerConnection(plugin);
		folder = (await readReadingPolicy(plugin))?.folder_path ?? folder;
		assertCurrent();
	}
	const { title, message } = CONFIRMATIONS[feature];
	return openConfirmationModal(plugin.app, { title, message: message(folder), confirmText: 'Turn on' });
}

const WAITING_NOTICES: Record<Feature, string> = {
	reading: 'Reading is on for your Crate server. To use it in this vault, turn it on in Crate settings.',
	reminders: 'Reminders are on for your Crate server. To use them in this vault, turn them on in Crate settings.',
};
const announced = new WeakMap<CratePlugin, Set<Feature>>();
/** Once per load, points out a server feature this vault has not confirmed. */
function announceUnconfirmed(plugin: CratePlugin, policy: SharedFeatures): void {
	let features = announced.get(plugin);
	if (!features) { features = new Set(); announced.set(plugin, features); }
	for (const feature of ['reminders', 'reading'] as const) {
		if (!policy[feature] || featureConfirmed(plugin, feature) || features.has(feature)) continue;
		features.add(feature);
		new Notice(WAITING_NOTICES[feature]);
	}
}

async function requestFeatures(plugin: CratePlugin, body?: unknown): Promise<FeaturePolicy> {
	const policy = parseFeaturePolicy(await serverRequest<unknown>(plugin, '/features', body, { timeout: 5_000 }));
	if (!policy) throw new Error('Could not read shared feature settings.');
	return policy;
}
const tasks = new WeakMap<CratePlugin, Promise<void>>();
/** Returns whether a feature started or stopped in this vault. */
async function apply(plugin: CratePlugin, policy: FeaturePolicy, activate: boolean, assertCurrent: () => void): Promise<boolean> {
	assertCurrent();
	// A server policy alone never starts a feature in a vault that has not confirmed its folder.
	const reading = policy.reading && plugin.settings.reading.confirmed;
	const reminders = policy.reminders && plugin.remindersSettings.confirmed;
	const changed = plugin.settings.reading.enabled !== reading || plugin.remindersSettings.enabled !== reminders;
	if (plugin.settings.reading.enabled !== reading) {
		await plugin.writeSettings({ reading: { ...plugin.settings.reading, enabled: reading } }, assertCurrent);
		assertCurrent();
		restartReading(plugin, activate && reading);
	}
	if (plugin.remindersSettings.enabled !== reminders) {
		if (activate) {
			// Loaded on demand so settings screens do not load the reminders UI.
			const { setRemindersEnabled } = await import('../reminders/plugin-integration');
			await setRemindersEnabled(plugin, reminders, assertCurrent);
		} else await plugin.writeRemindersSettings({ enabled: reminders }, assertCurrent);
	}
	assertCurrent();
	return changed;
}
async function serialize(plugin: CratePlugin, action: (assertCurrent: () => void) => Promise<void>): Promise<void> {
	const { assertCurrent } = captureServerConnection(plugin);
	const next = (tasks.get(plugin) ?? Promise.resolve()).catch(() => {}).then(() => {
		assertCurrent();
		return action(assertCurrent);
	});
	tasks.set(plugin, next);
	return next;
}
export function refreshSharedFeatures(plugin: CratePlugin, activate = true): Promise<void> {
	return serialize(plugin, async assertCurrent => {
		if (!plugin.settings.workerUrl || getPluginLifecycleSignal(plugin).aborted) return;
		const policy = await requestFeatures(plugin);
		const changed = await apply(plugin, policy, activate, assertCurrent);
		assertCurrent();
		if (!activate) return;
		announceUnconfirmed(plugin, policy);
		if (changed) plugin.refreshSettingsTab();
	});
}
/** Turning a feature on here confirms it for this vault; ask first with `confirmFeatureFolder`. */
export function setSharedFeature(plugin: CratePlugin, feature: Feature, enabled: boolean): Promise<void> {
	return serialize(plugin, async assertCurrent => {
		if (enabled && !featureConfirmed(plugin, feature)) {
			if (feature === 'reading') await plugin.writeSettings({ reading: { ...plugin.settings.reading, confirmed: true } }, assertCurrent);
			else await plugin.writeRemindersSettings({ confirmed: true }, assertCurrent);
			assertCurrent();
		}
		if (!plugin.settings.workerUrl) {
			await apply(plugin, { reading: plugin.settings.reading.enabled, reminders: plugin.remindersSettings.enabled, revision: null, [feature]: enabled }, true, assertCurrent);
			return;
		}
		const current = await requestFeatures(plugin);
		assertCurrent();
		const policy = await requestFeatures(plugin, { feature, enabled, revision: current.revision });
		await apply(plugin, policy, true, assertCurrent);
	});
}
/** Automatic syncs can run every few seconds; the policy rarely changes. */
export const SHARED_FEATURES_REFRESH_INTERVAL_MS = 10 * 60_000;
export function registerSharedFeatures(plugin: CratePlugin): void {
	let refreshing = false;
	let lastRefreshAt: number | null = null;
	const refresh = () => {
		if (refreshing) return;
		refreshing = true;
		// Shared sync settings ride the same throttled refresh as the feature policy.
		void sharedSettingsSync(plugin).pull();
		void refreshSharedFeatures(plugin).then(() => { lastRefreshAt = Date.now(); })
			.catch(() => { /* Keep the last confirmed state offline. */ }).finally(() => { refreshing = false; });
	};
	// Changes from other devices arrive with sync; the server enforces them meanwhile.
	let wasSyncing = false;
	const listener = (state: SyncState) => {
		if (wasSyncing && state.status === 'idle'
			&& (lastRefreshAt === null || Date.now() - lastRefreshAt >= SHARED_FEATURES_REFRESH_INTERVAL_MS)) refresh();
		wasSyncing = state.status === 'syncing';
	};
	plugin.syncRuntime.addStateChangeListener(listener);
	plugin.register(() => plugin.syncRuntime.removeStateChangeListener(listener));
	refresh();
}
