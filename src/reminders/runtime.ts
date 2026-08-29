import { Notice } from 'obsidian';
import type CratePlugin from '../main';
import { createReminderIndex } from './data/reminder-index';
import { createMarkdownWriter } from './data/markdown-writer';
import { createReminderRepository } from './data/reminder-repository';
import { ReminderNotificationService } from './services/notificationService';
import { VaultWatcher } from './services/vaultWatcher';
import { createLogger } from './utils/logger';

const remindersLogger = createLogger('Reminders');

function createNotificationService(plugin: CratePlugin): ReminderNotificationService {
	return new ReminderNotificationService(
		() => plugin.settings,
		() => plugin.remindersSettings,
		() => plugin.syncRuntime.getApiClient(),
	);
}

function configureReminderWriterCallbacks(plugin: CratePlugin): void {
	plugin.markdownWriter.setOnFileWritten(async (file) => {
		await plugin.reminderIndex.rescanFile(file, true);
	});

	const notificationService = createNotificationService(plugin);
	plugin.markdownWriter.setOnReminderChange(async (reminder, operation) => {
		const result = await notificationService.onReminderChange(reminder, operation);
		if (!result.success) {
			new Notice(`Reminder saved but notification sync failed:\n${result.error}`, 5000);
		}
		return result;
	});
}

export async function setupReminderBackend(plugin: CratePlugin, folderPath: string): Promise<void> {
	plugin.remindersVaultWatcher?.unregister();

	plugin.reminderIndex = createReminderIndex(plugin.app, folderPath);
	await plugin.reminderIndex.load();
	plugin.markdownWriter = createMarkdownWriter(plugin.app, plugin.reminderIndex);
	plugin.reminderRepository = createReminderRepository(plugin.reminderIndex, plugin.markdownWriter);
	configureReminderWriterCallbacks(plugin);

	plugin.remindersVaultWatcher = new VaultWatcher(plugin, plugin.reminderIndex);
	plugin.remindersVaultWatcher.register();
}

export async function reconcileReminderNotifications(plugin: CratePlugin): Promise<void> {
	try {
		await createNotificationService(plugin).reconcile(plugin.reminderIndex.getAll());
	} catch (error) {
		remindersLogger.warn('Failed to reconcile reminder notifications:', error);
	}
}
