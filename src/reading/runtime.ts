import { readReadingPolicy, writeReadingPolicy } from './server';
import { captureServerConnection } from '../plugin/server-request';
import { Notice, TFolder } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { shouldIgnoreSyncPath, createIgnoreMatcherContext } from '../sync/local/ignore';
import { ReadingLibrary } from './data/library';
import { createObsidianReadingVault } from './data/obsidian-vault';
import { validateReadingFolder, type ReadingSettings } from './settings';

export const READING_VIEW_TYPE = 'crate-reading';

/** Reading state of one plugin instance. Only `runtime` ends with a stop; the rest outlives restarts. */
interface ReadingPluginState {
	/** The running library, replaced by every restart. */
	runtime?: { library: ReadingLibrary; stop: () => Promise<void> };
	/** Settles once every stopped library has drained, so a replacement starts after it. */
	stopping?: Promise<void>;
	listeners: Set<() => void>;
	/** A saved article may arrive by sync after the link opens Obsidian, so the request waits briefly for it. */
	requested?: { id: string; until: number };
}
const states = new WeakMap<CratePlugin, ReadingPluginState>();
function readingState(plugin: CratePlugin): ReadingPluginState {
	let state = states.get(plugin);
	if (!state) { state = { listeners: new Set() }; states.set(plugin, state); }
	return state;
}
export function subscribeReadingRuntime(plugin: CratePlugin, listener: () => void): () => void {
	const { listeners } = readingState(plugin);
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}
function notifyRuntime(plugin: CratePlugin): void { states.get(plugin)?.listeners.forEach(listener => listener()); }
export function requestReadingItem(plugin: CratePlugin, id: string): void {
	readingState(plugin).requested = { id, until: Date.now() + 120_000 }; notifyRuntime(plugin);
}
export function requestedReadingItem(plugin: CratePlugin): string | undefined {
	const state = states.get(plugin);
	if (state?.requested && state.requested.until <= Date.now()) state.requested = undefined;
	return state?.requested?.id;
}
export function clearRequestedReadingItem(plugin: CratePlugin): void {
	const state = states.get(plugin);
	if (state) state.requested = undefined;
}
export function getReadingLibrary(plugin: CratePlugin): ReadingLibrary | undefined { return states.get(plugin)?.runtime?.library; }
export function stopReading(plugin: CratePlugin): void {
	const state = states.get(plugin);
	if (state?.runtime) state.stopping = Promise.allSettled([state.stopping, state.runtime.stop()]).then(() => {});
	if (state) state.runtime = undefined;
	notifyRuntime(plugin);
}
export async function waitForStoppedReading(plugin: CratePlugin): Promise<void> { await states.get(plugin)?.stopping; }

// Compiled patterns are keyed by their text, so one cache serves every check.
const readingPatternCache = new Map<string, RegExp>();
function allowedReadingPath(plugin: CratePlugin, path: string): boolean {
	return !shouldIgnoreSyncPath(path, createIgnoreMatcherContext(
		[`${plugin.app.vault.configDir}/`], plugin.settings.ignorePatterns, readingPatternCache));
}

export function validateReadingConfiguration(plugin: CratePlugin, settings: ReadingSettings): string {
	const folder = validateReadingFolder(settings.folderPath, plugin.remindersSettings.remindersFolderPath, plugin.app.vault.configDir);
	if (!allowedReadingPath(plugin, `${folder}/reading.md`)) throw new Error('The reading folder is excluded from sync. Choose a folder that can sync.');
	const existing = plugin.app.vault.getAbstractFileByPath(folder);
	if (existing && !(existing instanceof TFolder)) throw new Error('The reading folder path is already a file.');
	return folder;
}

/** Agrees on one Reading folder with the server. A missing or paused server policy is
 * turned on, keeping the server's folder when it has one. Returns true after adopting
 * a different server folder into settings, which needs a restart. */
async function reconcileReadingPolicy(plugin: CratePlugin, folder: string, assertCurrent: () => void): Promise<boolean> {
	const policy = await readReadingPolicy(plugin);
	assertCurrent();
	if (!policy || !policy.enabled) {
		await writeReadingPolicy(plugin, { enabled: true, folderPath: policy?.folder_path ?? folder, revision: policy?.revision ?? null });
		assertCurrent();
	}
	if (!policy || policy.folder_path === folder) return false;
	const reading = { ...plugin.settings.reading, folderPath: policy.folder_path };
	validateReadingConfiguration(plugin, reading);
	await plugin.writeSettings({ reading }, assertCurrent);
	assertCurrent();
	return true;
}

export function startReading(plugin: CratePlugin): void {
	stopReading(plugin);
	if (!plugin.settings.reading.enabled) return;
	const lifetime = getPluginLifecycleSignal(plugin);
	lifetime.throwIfAborted();
	const folder = validateReadingConfiguration(plugin, plugin.settings.reading);
	const controller = new AbortController();
	const { vault } = plugin.app;
	const readingVault = createObsidianReadingVault(vault, folder, {
		signal: controller.signal,
		allowed: path => allowedReadingPath(plugin, path),
		validate: () => { validateReadingConfiguration(plugin, plugin.settings.reading); },
		fileManager: plugin.app.fileManager,
	});
	let policyChecked = !plugin.settings.workerUrl;
	let checkedAt = 0;
	const canAdopt = () => policyChecked && plugin.app.workspace.layoutReady && !['syncing', 'error', 'offline'].includes(plugin.syncRuntime.getState().status);
	// Keep replacement views synchronous, but start their vault work after the old library drains.
	const library = new ReadingLibrary({ ...readingVault,
		// Background tabs count too: their editor reloads the note when selected.
		editing: path => plugin.app.workspace.getLeavesOfType('markdown').some(leaf => leaf.getViewState().state?.file === path),
		...{ captureArticle: async (url: string, signal: AbortSignal) => {
			const { captureDesktopArticle } = await import('./desktop-capture');
			return captureDesktopArticle(url, signal);
		} },
	}, folder, controller.signal, canAdopt, states.get(plugin)?.stopping);
	let timer: number | undefined;
	let lastErrorAt = 0;
	const refreshes = new Set<Promise<void>>();
	const refresh = () => {
		if (controller.signal.aborted || !plugin.app.workspace.layoutReady || plugin.syncRuntime.getState().status === 'syncing') return;

		if (plugin.settings.workerUrl && Date.now() - checkedAt > 60_000) {
			checkedAt = Date.now();
			void (async () => {
				const connection = captureServerConnection(plugin);
				return reconcileReadingPolicy(plugin, folder, () => { controller.signal.throwIfAborted(); connection.assertCurrent(); });
			})().then(adopted => {
				if (adopted) startReading(plugin);
				else { policyChecked = true; schedule(); }
			}).catch(() => { /* Keep local data readable. Adoption waits for authoritative folder setup. */ });
		}
		const work = library.refresh().catch(error => { if (!controller.signal.aborted && Date.now() - lastErrorAt > 60_000) { lastErrorAt = Date.now(); new Notice(error instanceof Error ? error.message : 'Could not refresh Reading.'); } });
		refreshes.add(work); void work.finally(() => refreshes.delete(work));
	};
	const schedule = () => {
		if (controller.signal.aborted) return;
		window.clearTimeout(timer); timer = window.setTimeout(refresh, 400);
	};
	const inFolder = (path: string) => path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`);
	const changed = (path: string) => {
		if (!inFolder(path)) return;
		// The event changes the file's revision; renamed paths are new cache keys and the scan prunes old ones.
		readingVault.changed(path); schedule();
	};
	const refs = [
		vault.on('create', file => { changed(file.path); }),
		vault.on('modify', file => { changed(file.path); }),
		vault.on('delete', file => { changed(file.path); }),
		vault.on('rename', (file, oldPath) => { changed(oldPath); changed(file.path); }),
	];
	// Closing an editor lets deferred highlight records proceed.
	const layoutRef = plugin.app.workspace.on('layout-change', schedule);
	plugin.syncRuntime.addStateChangeListener(schedule);
	const stop = () => {
		controller.abort(); window.clearTimeout(timer);
		for (const ref of refs) vault.offref(ref);
		plugin.app.workspace.offref(layoutRef);
		plugin.syncRuntime.removeStateChangeListener(schedule);
		lifetime.removeEventListener('abort', onAbort);
		return Promise.allSettled([library.close(), ...refreshes]).then(() => {});
	};
	const onAbort = () => { void stop(); };
	lifetime.addEventListener('abort', onAbort, { once: true });
	readingState(plugin).runtime = { library, stop };
	notifyRuntime(plugin);
	plugin.app.workspace.onLayoutReady(() => { if (!controller.signal.aborted) schedule(); });
}

/** Applies changed Reading settings; open views close because they hold the previous library. */
export function restartReading(plugin: CratePlugin, start = true): void {
	stopReading(plugin);
	plugin.app.workspace.detachLeavesOfType(READING_VIEW_TYPE);
	if (start) startReading(plugin);
}
