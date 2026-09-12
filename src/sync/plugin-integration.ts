import { showSyncErrorNotice } from '../ui/sync-error-notice';
import { Notice, type TAbstractFile } from 'obsidian';
import type CratePlugin from '../main';
import { type ForegroundSyncReason, SyncRuntime } from './runtime';
import { notifyConflicts } from './conflict';
import { ActivityModal } from '../ui/activity-modal';
import { applySharedSettings } from './shared-settings';
import { SyncApiClient } from './api';
import { errorMessage } from '../plugin/logger';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';

const registeredVaultHandlers = new WeakSet<CratePlugin>();

export function initializeSyncManagers(plugin: CratePlugin): void {
	plugin.syncRuntime = new SyncRuntime(
		plugin,
		plugin.settings,
		plugin.secretStorage,
		() => plugin.saveSettings(),
	);
	plugin.syncRuntime.setStatusBarClickHandler(() => {
		new ActivityModal(plugin.app, plugin.settings, plugin.syncRuntime).open();
	});
}

export function registerSyncCommands(plugin: CratePlugin): void {
	plugin.addCommand({
		id: 'sync-now',
		name: 'Sync now',
		checkCallback: (checking) => {
			const available = plugin.syncRuntime.isConfigured();
			if (!checking && available) {
				void runSyncNow(plugin);
			}
			return available;
		},
	});

	plugin.addCommand({
		id: 'show-activity',
		name: 'Show sync activity',
		callback: () => {
			new ActivityModal(plugin.app, plugin.settings, plugin.syncRuntime).open();
		},
	});
}

async function runSyncNow(plugin: CratePlugin): Promise<void> {
	try {
		const result = await plugin.syncRuntime.sync();
		if (!result.success) {
			showSyncErrorNotice(plugin, 'Sync completed with errors.');
		}
		notifyConflicts(result.conflicts);
	} catch (error) {
		new Notice(`Sync failed: ${errorMessage(error)}`);
	}
}

export function registerVaultSyncEventHandlers(plugin: CratePlugin): void {
	if (registeredVaultHandlers.has(plugin)) {
		return;
	}
	registeredVaultHandlers.add(plugin);

	plugin.registerEvent(
		plugin.app.vault.on('create', (file: TAbstractFile) => {
			plugin.syncRuntime.onFileChange(file);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on('modify', (file: TAbstractFile) => {
			plugin.syncRuntime.onFileChange(file);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on('delete', (file: TAbstractFile) => {
			plugin.syncRuntime.onFileDelete(file);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
			plugin.syncRuntime.onFileRename(file, oldPath);
		}),
	);

	const triggerForegroundSync = (reason: ForegroundSyncReason): void => {
		plugin.syncRuntime.triggerForegroundSync(reason);
	};

	plugin.registerDomEvent(window, 'focus', () => {
		triggerForegroundSync('focus');
	});

	plugin.registerDomEvent(window, 'online', () => {
		triggerForegroundSync('online');
	});

	plugin.registerDomEvent(document, 'visibilitychange', () => {
		if (document.visibilityState === 'visible') {
			triggerForegroundSync('visible');
		}
	});
}

export async function configureCloudflareAuthorizedDevice(
	plugin: CratePlugin,
	workerUrl: string,
	authToken: string,
): Promise<{ success: boolean; error?: string }> {
	const signal = getPluginLifecycleSignal(plugin);
	signal.throwIfAborted();
	const api = new SyncApiClient(workerUrl, authToken);
	try {
		const { settings } = await api.getSharedSettings();
		signal.throwIfAborted();
		if (settings) applySharedSettings(plugin.settings, settings);
	} catch {
		// Shared settings are optional during first connection.
	}
	signal.throwIfAborted();

	await plugin.syncRuntime.applyInfrastructureConfig({
		workerUrl,
		authToken,
	}, signal);
	signal.throwIfAborted();

	void plugin.syncRuntime.pushSharedSettingsBestEffort();
	return await plugin.syncRuntime.testConnection();
}
