import type CratePlugin from '../main';
import { createReminderIndex } from './data/reminder-index';
import { createMarkdownWriter } from './data/markdown-writer';
import { createReminderRepository } from './data/reminder-repository';
import { VaultWatcher } from './services/vaultWatcher';
import { createLogger } from './utils/logger';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { Notice } from 'obsidian';
import { createReminderMoveJournal, type ReminderMoveJournal } from './data/reminder-move-journal';

const remindersLogger = createLogger('Reminders');
const notificationTasks = new WeakMap<CratePlugin, Promise<void>>();
const backends = new WeakMap<CratePlugin, AbortController>();
const moveJournals = new WeakMap<CratePlugin, ReminderMoveJournal>();

function reportMoveRecoveryIssues(issues: string[]): void {
	if (!issues.length) return;
	for (const issue of issues) remindersLogger.error(issue);
	new Notice(issues.join('\n\n'), 0);
}

export async function recoverInterruptedReminderMoves(plugin: CratePlugin): Promise<void> {
	const journal = moveJournals.get(plugin);
	if (!journal) { new Notice('Enable reminders before recovering an interrupted move.'); return; }
	if (plugin.syncRuntime.getState().status === 'syncing') { new Notice('Wait for sync to finish, then recover interrupted reminder moves.'); return; }
	const issues = await journal.recover();
	await plugin.reminderIndex.load();
	reportMoveRecoveryIssues(issues);
	if (!issues.length) new Notice('Interrupted reminder moves recovered.');
}

export function stopReminderBackend(plugin: CratePlugin): void {
	backends.get(plugin)?.abort();
	backends.delete(plugin);
	plugin.remindersVaultWatcher?.unregister();
	plugin.remindersVaultWatcher = undefined;
}

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
	const journal = createReminderMoveJournal(plugin.app, `${plugin.manifest.dir}/reminder-moves`, folderPath, controller.signal);
	moveJournals.set(plugin, journal);
	controller.signal.addEventListener('abort', () => { if (moveJournals.get(plugin) === journal) moveJournals.delete(plugin); }, { once: true });
	try {
		if (plugin.syncRuntime.getState().status !== 'syncing') reportMoveRecoveryIssues(await journal.recover());
	} catch (error) {
		const cancelled = controller.signal.aborted;
		controller.abort();
		if (cancelled) return false;
		throw error;
	}
	if (controller.signal.aborted) return false;

	let verifiedApi = plugin.syncRuntime.getApiClient();
	let syncingApi: typeof verifiedApi = null;
	const index = createReminderIndex(plugin.app, folderPath, controller.signal,
		path => !plugin.app.workspace.layoutReady || plugin.syncRuntime.getState().status === 'syncing' || Boolean(path && journal.isPendingFile(path)),
		() => {
			const api = plugin.syncRuntime.getApiClient();
			return journal.hasPending() || plugin.syncRuntime.isConfigured() && (!api || api !== verifiedApi)
				|| ['error', 'offline'].includes(plugin.syncRuntime.getState().status);
		});
	const onSyncStateChanged = () => {
		const { status } = plugin.syncRuntime.getState();
		const api = plugin.syncRuntime.getApiClient();
		if (status === 'syncing') syncingApi = api;
		else {
			if (status === 'idle' && api && syncingApi === api) verifiedApi = api;
			syncingApi = null;
		}
		const refresh = async () => {
			if (status === 'syncing' || controller.signal.aborted) return;
			if (journal.hasPending()) {
				reportMoveRecoveryIssues(await journal.recover());
				await index.load();
			}
			await index.flushDeferredScans();
		};
		void refresh().catch((error: unknown) => { if (!controller.signal.aborted) remindersLogger.error('Failed to refresh reminders after sync:', error); });
	};
	plugin.syncRuntime.addStateChangeListener(onSyncStateChanged);
	controller.signal.addEventListener('abort', () => plugin.syncRuntime.removeStateChangeListener(onSyncStateChanged), { once: true });
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
	plugin.markdownWriter = createMarkdownWriter(plugin.app, index, journal);
	plugin.reminderRepository = createReminderRepository(index, plugin.markdownWriter);
	plugin.markdownWriter.setOnFileWritten(async (file) => {
		await index.rescanFile(file, true);
	});

	plugin.remindersVaultWatcher = new VaultWatcher(
		plugin,
		plugin.reminderIndex,
	);
	plugin.remindersVaultWatcher.register();
	// During application startup the vault's in-memory file list is still empty.
	// Do not interpret that as an empty reminders folder or block plugin loading
	// by awaiting layout readiness; resume the deferred scan once files are ready.
	if (!plugin.app.workspace.layoutReady) {
		plugin.app.workspace.onLayoutReady(() => {
			if (controller.signal.aborted) return;
			void index.flushDeferredScans().catch((error: unknown) => {
				if (!controller.signal.aborted) remindersLogger.error('Failed to load reminders after vault startup:', error);
			});
		});
	}
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
