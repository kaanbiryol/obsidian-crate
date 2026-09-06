import type CratePlugin from '../main';
import { createReminderIndex } from './data/reminder-index';
import { createMarkdownWriter } from './data/markdown-writer';
import { createReminderRepository } from './data/reminder-repository';
import { VaultWatcher } from './services/vaultWatcher';
import { createLogger } from './utils/logger';

const remindersLogger = createLogger('Reminders');
const notificationTasks = new WeakMap<CratePlugin, Promise<void>>();

export async function setupReminderBackend(plugin: CratePlugin, folderPath: string): Promise<void> {
	plugin.remindersVaultWatcher?.unregister();

	plugin.reminderIndex = createReminderIndex(plugin.app, folderPath);
	await plugin.reminderIndex.load();
	plugin.markdownWriter = createMarkdownWriter(plugin.app, plugin.reminderIndex);
	plugin.reminderRepository = createReminderRepository(plugin.reminderIndex, plugin.markdownWriter);
	plugin.markdownWriter.setOnFileWritten(async (file) => {
		await plugin.reminderIndex.rescanFile(file, true);
	});

	plugin.remindersVaultWatcher = new VaultWatcher(
		plugin,
		plugin.reminderIndex,
	);
	plugin.remindersVaultWatcher.register();
}

export async function ensureReminderNotificationPolicy(plugin: CratePlugin): Promise<void> {
	const api = plugin.syncRuntime.getApiClient();
	if (!plugin.settings.pushEnabled || !api) return;
	const active = notificationTasks.get(plugin);
	if (active) return active;
	const settings = plugin.remindersSettings;
	const task = api.ensureNotificationPolicy({
		folderPath: settings.remindersFolderPath,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		allDayTime: settings.allDayNotificationTime,
	}).then(() => undefined).catch((error: unknown) => {
		remindersLogger.warn('Failed to initialize reminder notification policy:', error);
	});
	notificationTasks.set(plugin, task);
	try {
		await task;
	} finally {
		if (notificationTasks.get(plugin) === task) notificationTasks.delete(plugin);
	}
}
