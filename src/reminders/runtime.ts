import type CratePlugin from '../main';
import { createReminderIndex } from './data/reminder-index';
import { createMarkdownWriter } from './data/markdown-writer';
import { createReminderRepository } from './data/reminder-repository';
import { VaultWatcher } from './services/vaultWatcher';
import { createLogger } from './utils/logger';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';

const remindersLogger = createLogger('Reminders');
const notificationTasks = new WeakMap<CratePlugin, Promise<void>>();
const backends = new WeakMap<CratePlugin, AbortController>();

export async function setupReminderBackend(plugin: CratePlugin, folderPath: string): Promise<boolean> {
	const lifetime = getPluginLifecycleSignal(plugin);
	if (lifetime.aborted) return false;
	backends.get(plugin)?.abort();
	const controller = new AbortController();
	backends.set(plugin, controller);
	const abort = () => controller.abort();
	lifetime.addEventListener('abort', abort, { once: true });
	controller.signal.addEventListener('abort', () => lifetime.removeEventListener('abort', abort), { once: true });
	plugin.remindersVaultWatcher?.unregister();

	const index = createReminderIndex(plugin.app, folderPath, controller.signal);
	try {
		await index.load();
	} catch (error) {
		const cancelled = controller.signal.aborted;
		controller.abort();
		if (cancelled) return false;
		throw error;
	}
	if (controller.signal.aborted) return false;
	plugin.reminderIndex = index;
	plugin.markdownWriter = createMarkdownWriter(plugin.app, index);
	plugin.reminderRepository = createReminderRepository(index, plugin.markdownWriter);
	plugin.markdownWriter.setOnFileWritten(async (file) => {
		await index.rescanFile(file, true);
	});

	plugin.remindersVaultWatcher = new VaultWatcher(
		plugin,
		plugin.reminderIndex,
	);
	plugin.remindersVaultWatcher.register();
	return true;
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
