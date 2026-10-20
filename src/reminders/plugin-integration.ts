import type CratePlugin from '../plugin/CratePlugin';
import { registerReminderIntegrations } from './register-integrations';
import { setupReminderBackend } from './runtime';
import { ensureReminderNotificationPolicy } from './notification-policy-sync';
import { normalizeRemindersFolderPath } from './settings';
import { createLogger } from './logger';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';

const remindersLogger = createLogger('Reminders');

export async function initializeReminders(plugin: CratePlugin): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	remindersLogger.info(`Initializing reminders for folder: ${plugin.remindersSettings.remindersFolderPath}`);
	if (!await setupReminderBackend(plugin, plugin.remindersSettings.remindersFolderPath) || signal.aborted) return;
	remindersLogger.info(`Index loaded: ${plugin.reminderIndex.getAll().length} reminders`);

	await registerReminderIntegrations(plugin);
}

export async function reinitializeReminders(
	plugin: CratePlugin,
	newFolderPath: string,
): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	const normalizedFolderPath = normalizeRemindersFolderPath(newFolderPath);
	remindersLogger.info(`Reinitializing with new folder: ${normalizedFolderPath}`);
	if (!await setupReminderBackend(plugin, normalizedFolderPath) || signal.aborted) return;
	await registerReminderIntegrations(plugin);
	void ensureReminderNotificationPolicy(plugin);
	remindersLogger.info('Reinitialization complete');
}
