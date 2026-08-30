import { Notice } from 'obsidian';
import type CratePlugin from '../main';
import { createReminderIndex } from './data/reminder-index';
import { createMarkdownWriter } from './data/markdown-writer';
import { createReminderRepository } from './data/reminder-repository';
import { ReminderNotificationService } from './services/notificationService';
import { VaultWatcher } from './services/vaultWatcher';
import { createLogger } from './utils/logger';

const remindersLogger = createLogger('Reminders');
const notificationTasks = new WeakMap<CratePlugin, Promise<void>>();
const notificationReconciliationSuspended = new WeakSet<CratePlugin>();

function enqueueNotificationWork(plugin: CratePlugin, work: () => Promise<void>): Promise<void> {
	const previousTask = notificationTasks.get(plugin) ?? Promise.resolve();
	const currentTask = previousTask.catch(() => undefined).then(work);
	notificationTasks.set(plugin, currentTask);
	void currentTask.finally(() => {
		if (notificationTasks.get(plugin) === currentTask) {
			notificationTasks.delete(plugin);
		}
	}).catch(() => undefined);
	return currentTask;
}

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

	plugin.remindersVaultWatcher = new VaultWatcher(
		plugin,
		plugin.reminderIndex,
		() => reconcileReminderNotifications(plugin),
	);
	plugin.remindersVaultWatcher.register();
}

export async function reconcileReminderNotifications(plugin: CratePlugin): Promise<void> {
	if (notificationReconciliationSuspended.has(plugin)) return;
	await enqueueNotificationWork(plugin, async () => {
		if (notificationReconciliationSuspended.has(plugin)) return;
		try {
			await createNotificationService(plugin).reconcile(plugin.reminderIndex.getAll());
		} catch (error) {
			remindersLogger.warn('Failed to reconcile reminder notifications:', error);
		}
	});
}

export async function disableReminderNotifications(plugin: CratePlugin): Promise<void> {
	notificationReconciliationSuspended.add(plugin);
	try {
		await enqueueNotificationWork(plugin, () => createNotificationService(plugin).cancelAll());
	} catch (error) {
		notificationReconciliationSuspended.delete(plugin);
		await reconcileReminderNotifications(plugin);
		throw error;
	}
}

export async function enableReminderNotifications(plugin: CratePlugin): Promise<void> {
	notificationReconciliationSuspended.delete(plugin);
	await reconcileReminderNotifications(plugin);
}
