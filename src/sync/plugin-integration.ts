import { Notice, type TAbstractFile } from 'obsidian';
import { CloudflareSessionManager } from '../cloudflare/session-manager';
import type CratePlugin from '../main';
import { SECRET_KEYS } from '../plugin/types';
import { SyncRuntime } from './runtime';
import { notifyConflicts } from './conflict';
import { isHiddenPath } from './file-discovery';
import { ActivityModal } from '../ui/activity-modal';
import { openConfirmationModal } from '../ui/confirmation-modal';
import { applySharedSettings, parseSharedSettingsFromSetupParams } from './shared-settings';

const registeredVaultHandlers = new WeakSet<CratePlugin>();

export function initializeSyncManagers(plugin: CratePlugin): void {
	plugin.cloudflareSession = new CloudflareSessionManager(
		plugin.settings,
		plugin.secretStorage,
		() => plugin.saveSettings(),
	);
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

	type RawOn = (name: 'raw', callback: (path: string) => void) => import('obsidian').EventRef;
	plugin.registerEvent(
		(plugin.app.vault.on as unknown as RawOn)(
			'raw',
			(path: string) => {
				if (isHiddenPath(path)) {
					plugin.syncRuntime.onRawFileEvent(path);
				}
			},
		),
	);
}

export async function handleSyncSetupProtocol(
	plugin: CratePlugin,
	params: Record<string, string>,
): Promise<void> {
	const workerUrl = params['workerUrl'];
	const authToken = params['authToken'];

	if (!workerUrl || !authToken) {
		new Notice('Setup link is missing required parameters.');
		return;
	}

	if (plugin.syncRuntime.isConfigured()) {
		const confirmed = await openConfirmationModal(plugin.app, {
			title: 'Overwrite existing configuration',
			message: 'Crate is already configured on this device.',
			details: ['Applying the setup link will replace the current sync credentials.'],
			confirmText: 'Overwrite configuration',
			warning: true,
		});
		if (!confirmed) {
			return;
		}
	}

	try {
		const sharedSettingsUpdate = parseSharedSettingsFromSetupParams(params);
		if (Object.keys(sharedSettingsUpdate).length > 0) {
			applySharedSettings(plugin.settings, {
				ignorePatterns: sharedSettingsUpdate.ignorePatterns ?? plugin.settings.ignorePatterns,
				syncOnStartup: sharedSettingsUpdate.syncOnStartup ?? plugin.settings.syncOnStartup,
				syncInterval: sharedSettingsUpdate.syncInterval ?? plugin.settings.syncInterval,
				showStatusBar: sharedSettingsUpdate.showStatusBar ?? plugin.settings.showStatusBar,
				pushEnabled: sharedSettingsUpdate.pushEnabled ?? plugin.settings.pushEnabled,
			});
		}

		if (params['analyticsToken']) {
			plugin.secretStorage.set(SECRET_KEYS.ANALYTICS_TOKEN, params['analyticsToken']);
		}

		await plugin.syncRuntime.applyInfrastructureConfig({
			workerUrl,
			authToken,
			workerName: params['workerName'] || '',
			bucketName: params['bucketName'] || '',
			databaseId: params['databaseId'] || '',
			accountId: params['accountId'] || undefined,
		});
		new Notice('Crate configured from setup link');

		const result = await plugin.syncRuntime.testConnection();
		if (result.success) {
			new Notice('Connection test successful!');
		} else {
			new Notice(`Configured but connection test failed: ${result.error}`);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : 'Unknown error';
		new Notice(`Setup link failed: ${msg}`);
	}
}
