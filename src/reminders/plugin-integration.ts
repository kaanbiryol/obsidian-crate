import { Notice, type MarkdownPostProcessorContext } from 'obsidian';
import type CratePlugin from '../main';
import { createReminderIndex } from './data/reminderIndex';
import { migrateReminderIds } from './data/reminderIdMigration';
import { createMarkdownWriter } from './data/markdownWriter';
import { createStorageCompat } from './data/storageCompat';
import { ReminderQueryInjector } from './query/injector';
import { createInlineTodoExtension } from './query/inlineTodoLivePreview';
import { createRemindersBlockExtension } from './query/remindersBlockLivePreview';
import { registerReminderCommands } from './commands';
import { normalizeRemindersFolderPath } from './settings';
import { FileRenameHandler } from './services/fileRenameHandler';
import { ReminderNotificationService } from './services/notificationService';
import { VaultWatcher } from './services/vaultWatcher';
import { openFullScreenReminderModal } from './ui/modals';
import { RemindersView, VIEW_TYPE_REMINDERS } from './ui/reminders-view';
import { configureLogger, createLogger } from './utils/logger';
import { loadRemindersSettings } from './settings-storage';

const remindersLogger = createLogger('Reminders');
const registeredReminderUi = new WeakSet<CratePlugin>();

function createNotificationService(plugin: CratePlugin): ReminderNotificationService {
	return new ReminderNotificationService(
		() => plugin.settings,
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

async function setupReminderBackend(plugin: CratePlugin, folderPath: string): Promise<void> {
	plugin.remindersVaultWatcher?.unregister();

	plugin.reminderIndex = createReminderIndex(plugin.app, folderPath);
	await plugin.reminderIndex.load();
	plugin.markdownWriter = createMarkdownWriter(plugin.app, plugin.reminderIndex);
	plugin.storage = createStorageCompat(plugin.reminderIndex, plugin.markdownWriter);
	configureReminderWriterCallbacks(plugin);
	await reconcileReminderNotifications(plugin);

	plugin.remindersVaultWatcher = new VaultWatcher(plugin, plugin.reminderIndex);
	plugin.remindersVaultWatcher.register();

	const migrate = async () => {
		const result = await migrateReminderIds(plugin.app, folderPath);
		if (result.remindersUpdated > 0) {
			await plugin.reminderIndex.load();
		}
	};

	if (plugin.app.workspace.layoutReady) {
		await migrate();
	} else {
		plugin.app.workspace.onLayoutReady(() => void migrate());
	}
}

async function reconcileReminderNotifications(plugin: CratePlugin): Promise<void> {
	try {
		await createNotificationService(plugin).reconcile(plugin.reminderIndex.getAll());
	} catch (error) {
		remindersLogger.warn('Failed to reconcile reminder notifications:', error);
	}
}

function registerReminderIntegrations(plugin: CratePlugin): void {
	if (registeredReminderUi.has(plugin)) {
		return;
	}
	registeredReminderUi.add(plugin);

	const fileRenameHandler = new FileRenameHandler(plugin);
	fileRenameHandler.register();

	const queryProcessor = new ReminderQueryInjector(plugin);
	plugin.registerMarkdownCodeBlockProcessor(
		'reminders',
		(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onNewBlock(source, el, ctx),
	);
	plugin.registerMarkdownCodeBlockProcessor(
		'reminders-tasks',
		(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onNewBlock(source, el, ctx),
	);
	plugin.registerMarkdownCodeBlockProcessor(
		'reminders-today',
		(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onTodayBlock(source, el, ctx),
	);
	plugin.registerMarkdownCodeBlockProcessor(
		'reminders-upcoming',
		(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onUpcomingBlock(source, el, ctx),
	);

	try {
		plugin.registerEditorExtension(createRemindersBlockExtension(plugin));
	} catch (error) {
		remindersLogger.error('Failed to register reminder block extension:', error);
	}
	try {
		plugin.registerEditorExtension(createInlineTodoExtension(plugin));
	} catch (error) {
		remindersLogger.error('Failed to register inline todo extension:', error);
	}

	plugin.registerView(
		VIEW_TYPE_REMINDERS,
		(leaf) => new RemindersView(leaf, plugin),
	);
	plugin.addRibbonIcon('check-circle', 'Open reminders', () => {
		void plugin.activateRemindersView();
	});

	registerReminderCommands(plugin);

	plugin.addCommand({
		id: 'open-reminders-view',
		name: 'Open reminders sidebar',
		callback: () => plugin.activateRemindersView(),
	});
	plugin.addCommand({
		id: 'open-reminders-fullscreen',
		name: 'Open reminders full screen',
		callback: () => openFullScreenReminderModal(plugin),
	});

	if (plugin.remindersSettings.autoOpenView !== 'none') {
		plugin.app.workspace.onLayoutReady(() => {
			if (plugin.remindersSettings.autoOpenView === 'sidebar') {
				void plugin.activateRemindersView();
			} else if (plugin.remindersSettings.autoOpenView === 'fullscreen') {
				openFullScreenReminderModal(plugin);
			}
		});
	}
}

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
