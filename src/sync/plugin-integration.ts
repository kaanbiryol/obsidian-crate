import { registerSyncStatus } from '../plugin/sync-status';
import { openFileHistoryModal } from '../ui/activity/file-history-modal';
import { showSyncErrorNotice } from '../ui/sync-error-notice';
import { Notice, TFile, type Events, type TAbstractFile } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { SyncRuntime } from './runtime/runtime';
import { notifyConflicts } from './conflict/conflict';
import { ActivityModal } from '../ui/activity/activity-modal';
import { errorMessage } from './logger';
import { getPluginLifecycleSignal, waitForSyncReady } from '../plugin/lifecycle-state';
import { queueEncryptedFolderMove, resumeEncryptedFolderMoves } from '../plugin/encryption-folder-moves';
import { ensureReminderNotificationPolicy, refreshReminderNotificationPolicy } from '../reminders/runtime';
import { SECRET_KEYS } from '../platform/secret-keys';
import type { ForegroundSyncReason } from './runtime/foreground-sync';

const registeredVaultHandlers = new WeakSet<CratePlugin>();

export function initializeSyncManagers(plugin: CratePlugin): void {
	plugin.registerDomEvent(window, 'online', () => { void refreshReminderNotificationPolicy(plugin); });
	plugin.syncRuntime = new SyncRuntime(
		plugin,
		plugin.settings,
		plugin.secretStorage,
		update => update ? plugin.writeSettings(update) : plugin.saveSettings(),
    () => ensureReminderNotificationPolicy(plugin, true),
	);
	registerSyncStatus(plugin, plugin.syncRuntime, () => {
		new ActivityModal(plugin.app, plugin.settings, plugin.syncRuntime).open();
	});
	let serverUnavailable = false;
	plugin.syncRuntime.addStateChangeListener(state => {
		if (state.status !== 'offline') { serverUnavailable = false; return; }
		if (serverUnavailable) return;
		serverUnavailable = true;
		const fragment = new DocumentFragment();
		fragment.createSpan({ text: `Crate server unavailable. ${state.lastError ?? 'Check your server connection.'} ` });
		const link = fragment.createEl('a', { text: 'Open Crate settings' });
		link.addEventListener('click', () => plugin.openSettingsTab());
		if (!plugin.settings.cloudflareDeployment) fragment.createSpan({ text: ' → Server details → Update server address.' });
		new Notice(fragment, 12_000);
	});
}

export function registerSyncCommands(plugin: CratePlugin): void {
	plugin.registerEvent(plugin.app.workspace.on('file-menu', (menu, file) => {
		if (!(file instanceof TFile) || !plugin.syncRuntime.isConfigured()) return;
		menu.addItem(item => item.setTitle('File history').setIcon('history').onClick(() => {
			openFileHistoryWhenReady(plugin, file.path);
		}));
	}));
	plugin.addCommand({
		id: 'show-file-history', name: 'Show file sync history',
		checkCallback: checking => {
			const file = plugin.app.workspace.getActiveFile();
			const available = plugin.syncRuntime.isConfigured() && file !== null;
			if (!checking && available) openFileHistoryWhenReady(plugin, file.path);
			return available;
		},
	});
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
		id: 'stop-sync',
		name: 'Stop sync',
		checkCallback: checking => {
			const available = plugin.syncRuntime.isConfigured();
			if (!checking && available) {
				void plugin.syncRuntime.stopSync()
					.then(() => { plugin.refreshSettingsTab(); new Notice('Sync stopped. Automatic sync is off on this device.'); })
					.catch(error => { new Notice(`Could not finish stopping sync: ${errorMessage(error)}`); });
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

function openFileHistoryWhenReady(plugin: CratePlugin, path: string): void {
	const signal = getPluginLifecycleSignal(plugin);
	void waitForSyncReady(plugin).then(() => {
		if (!signal.aborted) openFileHistoryModal(plugin.app, plugin.syncRuntime, path);
	});
}

async function runSyncNow(plugin: CratePlugin): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	try {
		// Startup initialization runs after the workspace is ready.
		await waitForSyncReady(plugin);
		if (signal.aborted) return;
		const result = await plugin.syncRuntime.sync();
		if (result.outcome === 'cancelled') return;
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
	const resumeFolders = () => {
		if (!plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) return;
		void resumeEncryptedFolderMoves(plugin).then(() => {
			new Notice('Encrypted folders updated. Open fresh web app links to reconnect reading and reminders.');
		}).catch(error => new Notice(`Folder move saved on this device. ${errorMessage(error)} Open Manage encryption to resume.`));
	};
	plugin.app.workspace.onLayoutReady(resumeFolders);

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
			try {
				if (queueEncryptedFolderMove(plugin, oldPath, file.path)) resumeFolders();
				else plugin.syncRuntime.onFileRename(file, oldPath);
			}
			catch (error) { plugin.syncRuntime.destroy(); new Notice(`Could not update the encrypted folder: ${errorMessage(error)}`); }
		}),
	);

	// Obsidian emits raw paths for configuration and hidden files that have no TFile.
	plugin.registerEvent(
		(plugin.app.vault as Events).on('raw', (path: unknown) => {
			if (typeof path === 'string') plugin.syncRuntime.onRawFileChange(path);
		}),
	);

	const triggerForegroundSync = (reason: ForegroundSyncReason): void => {
		plugin.syncRuntime.triggerForegroundSync(reason);
	};

	plugin.registerDomEvent(window, 'focus', () => {
		triggerForegroundSync('focus');
	});

	plugin.registerDomEvent(window, 'online', () => {
		resumeFolders();
		triggerForegroundSync('online');
	});

	plugin.registerDomEvent(document, 'visibilitychange', () => {
		if (document.visibilityState === 'visible') {
			triggerForegroundSync('visible');
		}
	});
}
