import { Notice, type TAbstractFile } from 'obsidian';
import type CratePlugin from '../main';
import { type ForegroundSyncReason, SyncRuntime } from './runtime';
import { notifyConflicts } from './conflict';
import { ActivityModal } from '../ui/activity-modal';
import { openConfirmationModal } from '../ui/confirmation-modal';
import { applySharedSettings } from './shared-settings';
import { SyncApiClient } from './api';

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
		callback: async () => {
			const result = await plugin.syncRuntime.sync();
			notifyConflicts(result.conflicts);
		},
	});

	plugin.addCommand({
		id: 'test-connection',
		name: 'Test connection',
		callback: async () => {
			const result = await plugin.syncRuntime.testConnection();
			if (result.success) {
				new Notice('Connection successful!');
			} else {
				new Notice(`Connection failed: ${result.error}`);
			}
		},
	});

	plugin.addCommand({
		id: 'show-activity',
		name: 'Show sync activity',
		callback: () => {
			new ActivityModal(plugin.app, plugin.settings, plugin.syncRuntime).open();
		},
	});

	plugin.addCommand({
		id: 'force-full-sync',
		name: 'Force full sync (overwrite remote)',
		callback: async () => {
			const confirmed = await openConfirmationModal(plugin.app, {
				title: 'Force full sync',
				message: 'Overwrite the remote vault with local files?',
				details: [
					'Remote-only files will be deleted.',
					'This action cannot be undone.',
				],
				confirmText: 'Force full sync',
				warning: true,
			});
			if (!confirmed) {
				return;
			}

			new Notice('Force full sync started...');
			const result = await plugin.syncRuntime.forceFullSync();
			if (result.success) {
				new Notice(`Force sync complete: ${result.uploaded} uploaded, ${result.deleted} deleted`);
			} else {
				new Notice(`Force sync completed with errors: ${result.errors.join(', ')}`);
			}
		},
	});
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
	const api = new SyncApiClient(workerUrl, authToken);
	try {
		const { settings } = await api.getSharedSettings();
		if (settings) applySharedSettings(plugin.settings, settings);
	} catch {
		// Shared settings are optional during first connection.
	}

	await plugin.syncRuntime.applyInfrastructureConfig({
		workerUrl,
		authToken,
	});

	void plugin.syncRuntime.pushSharedSettingsBestEffort();
	return await plugin.syncRuntime.testConnection();
}
