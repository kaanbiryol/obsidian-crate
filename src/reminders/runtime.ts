import type CratePlugin from '../plugin/CratePlugin';
import { createReminderIndex, type ReminderIndex } from './data/reminder-index';
import { createMarkdownWriter } from './data/markdown-writer';
import { createReminderRepository, type ReminderRepository } from './data/reminder-repository';
import { VaultWatcher } from './data/vault-watcher';
import { createLogger } from './logger';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { Notice } from 'obsidian';
import { validateReadingFolder } from '../reading/settings';
import { createReminderMoveJournal } from './data/reminder-move-journal';
import { createReminderScanGate } from './scan-gate';

/** The loaded reminders folder. A folder change replaces it; disabling reminders clears it. */
export interface ReminderBackend {
	index: ReminderIndex;
	repository: ReminderRepository;
	watcher: VaultWatcher;
}

const remindersLogger = createLogger('Reminders');
// The newest setup's lifetime, including a setup that has not published its backend yet.
const backends = new WeakMap<CratePlugin, AbortController>();
// Views subscribe once and follow every backend that replaces the current one.
const backendListeners = new WeakMap<CratePlugin, Set<() => void>>();

/** Open views read the plugin's index and repository, which a folder change replaces. */
export function subscribeReminderBackend(plugin: CratePlugin, listener: () => void): () => void {
	let listeners = backendListeners.get(plugin);
	if (!listeners) { listeners = new Set(); backendListeners.set(plugin, listeners); }
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/** User actions report a stopped or still-loading backend instead of failing on a missing field. */
export function requireReminderBackend(plugin: CratePlugin): ReminderBackend {
	if (!plugin.reminders) throw new Error('Reminders are not loaded. Try again, or check your folder in Crate settings.');
	return plugin.reminders;
}

/** Recovery reruns after every sync; a record awaiting review reports once until its issues change. */
function createMoveRecoveryReporter(): (issues: string[]) => void {
	let reported = '';
	return issues => {
		const text = issues.join('\n\n');
		if (text === reported) return;
		reported = text;
		if (!text) return;
		for (const issue of issues) remindersLogger.error(issue);
		new Notice(text, 0);
	};
}

export function stopReminderBackend(plugin: CratePlugin): void {
	backends.get(plugin)?.abort();
	backends.delete(plugin);
	plugin.reminders?.watcher.unregister();
	plugin.reminders = undefined;
}

export async function setupReminderBackend(plugin: CratePlugin, folderPath: string): Promise<ReminderBackend | undefined> {
	if (plugin.settings.reading?.enabled) validateReadingFolder(plugin.settings.reading.folderPath, folderPath, plugin.app.vault.configDir);
	const lifetime = getPluginLifecycleSignal(plugin);
	if (lifetime.aborted) return undefined;
	backends.get(plugin)?.abort();
	const controller = new AbortController();
	backends.set(plugin, controller);
	const abort = () => controller.abort();
	lifetime.addEventListener('abort', abort, { once: true });
	controller.signal.addEventListener('abort', () => lifetime.removeEventListener('abort', abort), { once: true });
	plugin.reminders?.watcher.unregister();
	const journal = createReminderMoveJournal(plugin.app, `${plugin.manifest.dir}/reminder-moves`, folderPath, controller.signal);
	const reportMoveRecoveryIssues = createMoveRecoveryReporter();
	try {
		if (plugin.syncRuntime.getState().status !== 'syncing') reportMoveRecoveryIssues(await journal.recover());
	} catch (error) {
		const cancelled = controller.signal.aborted;
		controller.abort();
		if (cancelled) return undefined;
		throw error;
	}
	if (controller.signal.aborted) return undefined;

	const gate = createReminderScanGate({ workspace: plugin.app.workspace, syncRuntime: plugin.syncRuntime, journal });
	const index = createReminderIndex(plugin.app, folderPath, {
		signal: controller.signal,
		shouldDeferScan: gate.shouldDeferScan,
		shouldDeferCollisionRepair: gate.shouldDeferCollisionRepair,
	});
	const onSyncStateChanged = () => {
		gate.onSyncStateChanged();
		const { status } = plugin.syncRuntime.getState();
		const refresh = async () => {
			if (status === 'syncing' || controller.signal.aborted) return;
			if (journal.hasPending()) {
				reportMoveRecoveryIssues(await journal.recover());
				// Reload only once recovery settles; a record awaiting review keeps its paths deferred.
				if (!journal.hasPending()) await index.load();
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
		if (cancelled) return undefined;
		throw error;
	}
	if (controller.signal.aborted) return undefined;
	const backend: ReminderBackend = {
		index,
		repository: createReminderRepository(index, createMarkdownWriter(plugin.app, index, journal)),
		watcher: new VaultWatcher(plugin.app.vault, index),
	};
	plugin.reminders = backend;
	backend.watcher.register();
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
	backendListeners.get(plugin)?.forEach(listener => listener());
	return backend;
}
