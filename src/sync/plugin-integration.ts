import { Notice, type TAbstractFile } from 'obsidian';
import { getCurrentDeviceName, getCurrentPlatformCode } from '../plugin/deviceInfo';
import type CratePlugin from '../main';
import { type ForegroundSyncReason, SyncRuntime } from './runtime';
import { notifyConflicts } from './conflict';
import { isHiddenPath } from './file-discovery';
import { ActivityModal } from '../ui/activity-modal';
import { openConfirmationModal } from '../ui/confirmation-modal';
import { applySharedSettings } from './shared-settings';
import { errorMessage } from '../plugin/logger';
import { exchangeDeviceEnrollment } from './enrollment';
import { claimAndEnrollInitialDevice } from './initial-server-setup';

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

export async function handleSyncSetupProtocol(
	plugin: CratePlugin,
	params: Record<string, string>,
): Promise<void> {
	const workerUrl = params['workerUrl'];
	const enrollmentToken = params['enrollmentToken'];

	if (!workerUrl || !enrollmentToken) {
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
		const testResult = await configureDeviceEnrollment(plugin, {
			workerUrl,
			enrollmentToken,
		});
		new Notice('Crate connected from setup link');
		if (testResult.success) {
			new Notice('Connection test successful!');
		} else {
			new Notice(`Configured but connection test failed: ${testResult.error}`);
		}
	} catch (error) {
		const msg = errorMessage(error);
		new Notice(`Setup link failed: ${msg}`);
	}
}

export async function configureInitialCloudflareDevice(
	plugin: CratePlugin,
	workerUrl: string,
): Promise<{ success: boolean; error?: string }> {
	if (plugin.syncRuntime.isConfigured()) {
		return { success: true };
	}

	const enrollment = await claimAndEnrollInitialDevice({
		workerUrl,
		deviceId: plugin.settings.deviceId,
		deviceName: getCurrentDeviceName(plugin.settings.deviceId),
		platform: getCurrentPlatformCode(),
	});

	return await applyDeviceEnrollment(plugin, enrollment);
}

async function configureDeviceEnrollment(
	plugin: CratePlugin,
	input: Parameters<typeof exchangeDeviceEnrollment>[0],
): Promise<{ success: boolean; error?: string }> {
	const enrollment = await exchangeDeviceEnrollment({
		...input,
		deviceId: plugin.settings.deviceId,
		deviceName: getCurrentDeviceName(plugin.settings.deviceId),
		platform: getCurrentPlatformCode(),
	});

	return await applyDeviceEnrollment(plugin, enrollment);
}

async function applyDeviceEnrollment(
	plugin: CratePlugin,
	enrollment: Awaited<ReturnType<typeof exchangeDeviceEnrollment>>,
): Promise<{ success: boolean; error?: string }> {
	if (enrollment.sharedSettings) {
		applySharedSettings(plugin.settings, enrollment.sharedSettings);
	}

	await plugin.syncRuntime.applyInfrastructureConfig({
		workerUrl: enrollment.workerUrl,
		authToken: enrollment.authToken,
	});

	plugin.syncRuntime.pushSharedSettings().catch(() => {});
	return await plugin.syncRuntime.testConnection();
}
