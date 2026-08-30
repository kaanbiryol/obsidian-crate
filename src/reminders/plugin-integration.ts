import type CratePlugin from '../main';
import { registerReminderIntegrations } from './register-integrations';
import { disableReminderNotifications, reconcileReminderNotifications, setupReminderBackend } from './runtime';
import { normalizeRemindersFolderPath } from './settings';
import { createLogger } from './utils/logger';

const remindersLogger = createLogger('Reminders');

export { disableReminderNotifications, reconcileReminderNotifications };

export async function initializeReminders(plugin: CratePlugin): Promise<void> {
	remindersLogger.info(`Initializing reminders for folder: ${plugin.remindersSettings.remindersFolderPath}`);
	await setupReminderBackend(plugin, plugin.remindersSettings.remindersFolderPath);
	remindersLogger.info(`Index loaded: ${plugin.reminderIndex.getAll().length} reminders`);

	registerReminderIntegrations(plugin);
}

export async function reinitializeReminders(
	plugin: CratePlugin,
	newFolderPath: string,
): Promise<void> {
	const normalizedFolderPath = normalizeRemindersFolderPath(newFolderPath);
	remindersLogger.info(`Reinitializing with new folder: ${normalizedFolderPath}`);
	await setupReminderBackend(plugin, normalizedFolderPath);
	await reconcileReminderNotifications(plugin);
	remindersLogger.info('Reinitialization complete');
}
