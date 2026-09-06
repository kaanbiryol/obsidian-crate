import type CratePlugin from '../main';
import { registerReminderIntegrations } from './register-integrations';
import {
	ensureReminderNotificationPolicy,
	setupReminderBackend,
} from './runtime';
import { normalizeRemindersFolderPath } from './settings';
import { createLogger } from './utils/logger';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';

const remindersLogger = createLogger('Reminders');

export { ensureReminderNotificationPolicy };

export async function initializeReminders(plugin: CratePlugin): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	remindersLogger.info(`Initializing reminders for folder: ${plugin.remindersSettings.remindersFolderPath}`);
	if (!await setupReminderBackend(plugin, plugin.remindersSettings.remindersFolderPath) || signal.aborted) return;
	remindersLogger.info(`Index loaded: ${plugin.reminderIndex.getAll().length} reminders`);

	registerReminderIntegrations(plugin);
}

export async function reinitializeReminders(
	plugin: CratePlugin,
	newFolderPath: string,
): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	const normalizedFolderPath = normalizeRemindersFolderPath(newFolderPath);
	remindersLogger.info(`Reinitializing with new folder: ${normalizedFolderPath}`);
	if (!await setupReminderBackend(plugin, normalizedFolderPath) || signal.aborted) return;
	registerReminderIntegrations(plugin);
	await ensureReminderNotificationPolicy(plugin);
	remindersLogger.info('Reinitialization complete');
}
