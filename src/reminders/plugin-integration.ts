import { Notice } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { registerReminderIntegrations } from './register-integrations';
import { setupReminderBackend, stopReminderBackend } from './runtime';
import { ensureReminderNotificationPolicy } from './notification-policy-sync';
import { normalizeRemindersFolderPath } from './settings';
import { createLogger } from './logger';
import { updateReminderVisibility } from './visibility';
import { VIEW_TYPE_REMINDERS } from './ui/plugin/reminders-view';
import { activateOrRevealRemindersLeaf } from './ui/plugin/workspaceLayout';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';

const remindersLogger = createLogger('Reminders');

export async function initializeReminders(plugin: CratePlugin): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	remindersLogger.info(`Initializing reminders for folder: ${plugin.remindersSettings.remindersFolderPath}`);
	const backend = await setupReminderBackend(plugin, plugin.remindersSettings.remindersFolderPath);
	if (!backend || signal.aborted) return;
	remindersLogger.info(`Index loaded: ${backend.index.getAll().length} reminders`);

	await registerReminderIntegrations(plugin, () => activateRemindersView(plugin));
}

export async function reinitializeReminders(
	plugin: CratePlugin,
	newFolderPath: string,
): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	const normalizedFolderPath = normalizeRemindersFolderPath(newFolderPath);
	remindersLogger.info(`Reinitializing with new folder: ${normalizedFolderPath}`);
	if (!await setupReminderBackend(plugin, normalizedFolderPath) || signal.aborted) return;
	await registerReminderIntegrations(plugin, () => activateRemindersView(plugin));
	void ensureReminderNotificationPolicy(plugin);
	remindersLogger.info('Reinitialization complete');
}

export async function reinitializeWithFolder(plugin: CratePlugin, newFolderPath: string): Promise<void> {
	if (!plugin.remindersSettings.enabled) {
		return;
	}
	await reinitializeReminders(plugin, newFolderPath);
}

export async function setRemindersEnabled(plugin: CratePlugin, enabled: boolean, assertCurrent?: () => void): Promise<void> {
	await plugin.writeRemindersSettings({ enabled }, assertCurrent);
	assertCurrent?.();
	if (enabled) {
		try { await initializeReminders(plugin); }
		catch (error) {
			assertCurrent?.();
			stopReminderBackend(plugin);
			await plugin.writeRemindersSettings({ enabled: false }, assertCurrent);
			assertCurrent?.();
			updateReminderVisibility(plugin);
			throw error;
		}
	} else {
		stopReminderBackend(plugin);
		plugin.app.workspace.detachLeavesOfType(VIEW_TYPE_REMINDERS);
	}
	assertCurrent?.();
	updateReminderVisibility(plugin);
}

export async function activateRemindersView(plugin: CratePlugin, project?: string): Promise<void> {
	if (!plugin.remindersSettings.enabled) { new Notice('Enable reminders in Crate settings first.'); return; }
	await activateOrRevealRemindersLeaf(plugin.app.workspace, VIEW_TYPE_REMINDERS, project, getPluginLifecycleSignal(plugin));
}
