import type CratePlugin from '../main';
import { registerReminderIntegrations } from './register-integrations';
import { setupReminderBackend } from './runtime';
import { normalizeRemindersFolderPath } from './settings';
import { loadRemindersSettings } from './settings-storage';
import { configureLogger, createLogger } from './utils/logger';

const remindersLogger = createLogger('Reminders');

export { reconcileReminderNotifications } from './runtime';

export async function initializeReminders(plugin: CratePlugin): Promise<void> {
	await loadRemindersSettings(plugin);

	configureLogger({ prefix: 'Crate', enabled: plugin.remindersSettings.debugLogging });

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
	remindersLogger.info('Reinitialization complete');
}
