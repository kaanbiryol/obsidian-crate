import { readReadingPolicy, writeReadingPolicy } from './server';
import { captureServerConnection } from '../plugin/server-request';
import { Notice, TFolder } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { shouldIgnoreSyncPath, createIgnoreMatcherContext } from '../sync/local/ignore';
import { ReadingLibrary } from './data/library';
import { ReadingMaintenance } from './data/maintenance';
import { ReadingCardPublisher } from './data/card-publisher';
import { decodePendingChange } from '../sync/pending/pending-change';
import { createScopedLogger, errorMessage } from '../platform/logger';
import type { SyncResult } from '../sync/types';
import { createObsidianReadingVault } from './data/obsidian-vault';
import { validateReadingFolder, type ReadingSettings } from './settings';

const logger = createScopedLogger('reading', 'cards');
export const READING_VIEW_TYPE = 'crate-reading';
/** Cards are posted this long after a sync completes, so a burst of syncs posts once. */
const CARD_PUBLISH_DELAY_MS = 5_000;
const CARD_FIRST_DELAY_MS = 30_000;
/** Vault events settle this long before a refresh; a burst, such as a sync download,
 * still refreshes at least every `REFRESH_MAX_WAIT_MS`. */
const REFRESH_DELAY_MS = 400;
const REFRESH_MAX_WAIT_MS = 2_000;

/** The plugin settings, vault, sync state and server credentials Reading runs on. */
type ReadingRuntimeHost = Pick<CratePlugin, 'app' | 'settings' | 'remindersSettings' | 'secretStorage' | 'syncRuntime' | 'writeSettings'>;

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
const states = new WeakMap<ReadingRuntimeHost, ReadingPluginState>();
function readingState(plugin: ReadingRuntimeHost): ReadingPluginState {
	let state = states.get(plugin);
	if (!state) { state = { listeners: new Set() }; states.set(plugin, state); }
	return state;
}
export function subscribeReadingRuntime(plugin: ReadingRuntimeHost, listener: () => void): () => void {
	const { listeners } = readingState(plugin);
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}
function notifyRuntime(plugin: ReadingRuntimeHost): void { states.get(plugin)?.listeners.forEach(listener => listener()); }
export function requestReadingItem(plugin: ReadingRuntimeHost, id: string): void {
	readingState(plugin).requested = { id, until: Date.now() + 120_000 }; notifyRuntime(plugin);
}
export function requestedReadingItem(plugin: ReadingRuntimeHost): string | undefined {
	const state = states.get(plugin);
	if (state?.requested && state.requested.until <= Date.now()) state.requested = undefined;
	return state?.requested?.id;
}
export function clearRequestedReadingItem(plugin: ReadingRuntimeHost): void {
	const state = states.get(plugin);
	if (state) state.requested = undefined;
}
export function getReadingLibrary(plugin: ReadingRuntimeHost): ReadingLibrary | undefined { return states.get(plugin)?.runtime?.library; }
export function stopReading(plugin: ReadingRuntimeHost): void {
	const state = states.get(plugin);
	if (state?.runtime) state.stopping = Promise.allSettled([state.stopping, state.runtime.stop()]).then(() => {});
	if (state) state.runtime = undefined;
	notifyRuntime(plugin);
}
export async function waitForStoppedReading(plugin: ReadingRuntimeHost): Promise<void> { await states.get(plugin)?.stopping; }

// Compiled patterns are keyed by their text, so one cache serves every check.
const readingPatternCache = new Map<string, RegExp>();
function allowedReadingPath(plugin: ReadingRuntimeHost, path: string): boolean {
	return !shouldIgnoreSyncPath(path, createIgnoreMatcherContext(
		[`${plugin.app.vault.configDir}/`], plugin.settings.ignorePatterns, readingPatternCache));
}

function validateReadingConfiguration(plugin: ReadingRuntimeHost, settings: ReadingSettings): string {
	const folder = validateReadingFolder(settings.folderPath, plugin.remindersSettings.remindersFolderPath, plugin.app.vault.configDir);
	if (!allowedReadingPath(plugin, `${folder}/reading.md`)) throw new Error('The reading folder is excluded from sync. Choose a folder that can sync.');
	const existing = plugin.app.vault.getAbstractFileByPath(folder);
	if (existing && !(existing instanceof TFolder)) throw new Error('The reading folder path is already a file.');
	return folder;
}

/** Agrees on one Reading folder with the server. A missing or paused server policy is
 * turned on, keeping the server's folder when it has one. Returns true after adopting
 * a different server folder into settings, which needs a restart. */
async function reconcileReadingPolicy(plugin: ReadingRuntimeHost, folder: string, assertCurrent: () => void): Promise<boolean> {
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

export function startReading(plugin: ReadingRuntimeHost): void {
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
		metadataCache: plugin.app.metadataCache,
	});
	let policyChecked = !plugin.settings.workerUrl;
	let checkedAt = 0;
	// Imports rewrite notes, so they wait while sync may change vault files. Reading does not.
	const canAdopt = () => policyChecked && plugin.app.workspace.layoutReady && !plugin.syncRuntime.isWritingVault()
		&& !['error', 'offline'].includes(plugin.syncRuntime.getState().status);
	// Keep replacement views synchronous, but start their vault work after the old library drains.
	const startAfter = states.get(plugin)?.stopping;
	// Background tabs count too: their editor reloads the note when selected.
	const editing = (path: string) => plugin.app.workspace.getLeavesOfType('markdown').some(leaf => leaf.getViewState().state?.file === path);
	// Imports and highlight records run whether or not Reading is open.
	const maintenance = new ReadingMaintenance({ ...readingVault, editing }, folder, controller.signal, canAdopt, startAfter);
	// The card list is built only while a Reading view or an action uses it.
	const library = new ReadingLibrary({ ...readingVault, editing,
		...{ captureArticle: async (url: string, signal: AbortSignal) => {
			const { captureDesktopArticle } = await import('./desktop-capture');
			return captureDesktopArticle(url, signal);
		} },
	}, folder, controller.signal, maintenance, startAfter);
	// In an encrypted vault, the cards the web app lists for the notes this device synced.
	const cardPublisher = new ReadingCardPublisher(readingVault, folder);
	let cardTimer: number | undefined, publishingCards = false, cardsAgain = false;
	const publishCards = async () => {
		cardTimer = undefined;
		if (controller.signal.aborted) return;
		if (publishingCards) { cardsAgain = true; return; }
		const api = plugin.syncRuntime.getApiClient();
		if (!api?.readingCardKeys()) return;
		if (plugin.syncRuntime.getState().status !== 'idle' || plugin.syncRuntime.isWritingVault()) { scheduleCards(); return; }
		publishingCards = true;
		try {
			// Only notes whose local copy is the synced one describe the server's revision.
			const pending = new Set(plugin.syncRuntime.getPendingKeys().map(key => decodePendingChange(key).path));
			await cardPublisher.publish(api, path => !pending.has(path), controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) logger.warn(`Reading cards were not posted: ${errorMessage(error)}`);
		} finally {
			publishingCards = false;
			if (cardsAgain) { cardsAgain = false; scheduleCards(); }
		}
	};
	const scheduleCards = (delay = CARD_PUBLISH_DELAY_MS) => {
		if (controller.signal.aborted) return;
		window.clearTimeout(cardTimer);
		cardTimer = window.setTimeout(() => { void publishCards(); }, delay);
	};
	const onSyncResult = (result: SyncResult) => { if (result.outcome === 'completed') scheduleCards(); };
	let timer: number | undefined;
	let scheduledAt = 0;
	let lastErrorAt = 0;
	const refreshes = new Set<Promise<void>>();
	// The first refresh finds clips waiting for import; later ones handle notes that changed
	// and retry work that waited for sync or an editor.
	let starting = true, retry = false;
	// Vault events update cards; re-indexed notes update cards from the cache and are checked
	// by the background work, which reads each once.
	const changedPaths = new Set<string>(), reindexedPaths = new Set<string>(), checkPaths = new Set<string>();
	const refresh = () => {
		timer = undefined;
		if (controller.signal.aborted || !plugin.app.workspace.layoutReady) return;

		// Adopting the server's folder restarts Reading, which a running download should not see change.
		if (plugin.settings.workerUrl && !plugin.syncRuntime.isWritingVault() && Date.now() - checkedAt > 60_000) {
			checkedAt = Date.now();
			void (async () => {
				const connection = captureServerConnection(plugin);
				return reconcileReadingPolicy(plugin, folder, () => { controller.signal.throwIfAborted(); connection.assertCurrent(); });
			})().then(adopted => {
				if (adopted) startReading(plugin);
				else { policyChecked = true; retry = true; schedule(); }
			}).catch(() => { /* Keep local data readable. Adoption waits for authoritative folder setup. */ });
		}
		const first = starting, paths = [...changedPaths], checks = [...checkPaths], retrying = retry;
		const reindexed = [...reindexedPaths].filter(path => !changedPaths.has(path));
		starting = false; retry = false; changedPaths.clear(); reindexedPaths.clear(); checkPaths.clear();
		const work = (async () => {
			if (first) await maintenance.start();
			if (checks.length) await maintenance.changed(checks);
			else if (retrying && !first) await maintenance.retry();
			if (!library.active) return;
			if (paths.length) await library.refreshPaths(paths);
			if (reindexed.length) await library.refreshProperties(reindexed);
		})().catch(error => { if (!controller.signal.aborted && Date.now() - lastErrorAt > 60_000) { lastErrorAt = Date.now(); new Notice(error instanceof Error ? error.message : 'Could not refresh Reading.'); } });
		refreshes.add(work); void work.finally(() => refreshes.delete(work));
	};
	const schedule = () => {
		if (controller.signal.aborted) return;
		const now = Date.now();
		if (timer === undefined) scheduledAt = now;
		else window.clearTimeout(timer);
		timer = window.setTimeout(refresh, Math.min(REFRESH_DELAY_MS, Math.max(0, scheduledAt + REFRESH_MAX_WAIT_MS - now)));
	};
	// Sync progress updates change nothing Reading uses; status and vault writes do.
	let syncPhase = '';
	const onSyncStateChange = () => {
		const phase = `${plugin.syncRuntime.getState().status}:${plugin.syncRuntime.isWritingVault()}`;
		if (phase === syncPhase) return;
		syncPhase = phase;
		retry = true; schedule();
	};
	const inFolder = (path: string) => path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`);
	const changed = (path: string) => {
		if (!inFolder(path)) return;
		// The event changes the file's revision, and the note is read rather than taken from
		// Obsidian's frontmatter cache, which updates after the event. A path that is not a
		// note, such as a renamed folder, lists the folder again.
		readingVault.changed(path); library.invalidate(path);
		changedPaths.add(path); schedule();
	};
	const refs = [
		vault.on('create', file => { changed(file.path); }),
		vault.on('modify', file => { changed(file.path); }),
		vault.on('delete', file => { changed(file.path); }),
		// A note moved into the folder is not re-indexed, so the background work checks it here.
		vault.on('rename', (file, oldPath) => { changed(oldPath); changed(file.path); if (inFolder(file.path)) checkPaths.add(file.path); }),
	];
	// Obsidian re-indexes a note after every change, including notes changed while it was
	// closed; cards then take the fresh properties without reading the notes.
	const metadataRef = plugin.app.metadataCache.on('changed', file => {
		if (!inFolder(file.path)) return;
		reindexedPaths.add(file.path); checkPaths.add(file.path); schedule();
	});
	// Closing an editor lets waiting imports and highlight records proceed; other layout changes need no work.
	const layoutRef = plugin.app.workspace.on('layout-change', () => { if (maintenance.waitingForEditor) { retry = true; schedule(); } });
	plugin.syncRuntime.addStateChangeListener(onSyncStateChange);
	plugin.syncRuntime.addSyncResultListener(onSyncResult);
	const stop = () => {
		controller.abort(); window.clearTimeout(timer); window.clearTimeout(cardTimer);
		plugin.syncRuntime.removeSyncResultListener(onSyncResult);
		for (const ref of refs) vault.offref(ref);
		plugin.app.workspace.offref(layoutRef);
		plugin.app.metadataCache.offref(metadataRef);
		plugin.syncRuntime.removeStateChangeListener(onSyncStateChange);
		lifetime.removeEventListener('abort', onAbort);
		return Promise.allSettled([library.close(), maintenance.close(), ...refreshes]).then(() => {});
	};
	const onAbort = () => { void stop(); };
	lifetime.addEventListener('abort', onAbort, { once: true });
	readingState(plugin).runtime = { library, stop };
	notifyRuntime(plugin);
	plugin.app.workspace.onLayoutReady(() => { if (!controller.signal.aborted) { schedule(); scheduleCards(CARD_FIRST_DELAY_MS); } });
}

/** Applies changed Reading settings; open views close because they hold the previous library. */
export function restartReading(plugin: ReadingRuntimeHost, start = true): void {
	stopReading(plugin);
	plugin.app.workspace.detachLeavesOfType(READING_VIEW_TYPE);
	if (start) startReading(plugin);
}

/** Moves Reading to another folder on the server, then on this device, and restarts it
 * there. The server changes the folder only while Reading is off, so an enabled server
 * policy is paused first. Every step stops once the server connection changes. */
export async function changeReadingFolder(plugin: ReadingRuntimeHost, folderPath: string): Promise<void> {
	const { assertCurrent } = captureServerConnection(plugin);
	validateReadingConfiguration(plugin, { ...plugin.settings.reading, folderPath });
	if (plugin.settings.workerUrl) {
		const policy = await readReadingPolicy(plugin);
		assertCurrent();
		if (policy?.enabled && policy.folder_path !== folderPath) {
			const paused = await writeReadingPolicy(plugin, { enabled: false, folderPath: policy.folder_path, revision: policy.revision });
			assertCurrent();
			policy.revision = paused.revision;
			policy.enabled = 0;
		}
		await writeReadingPolicy(plugin, { enabled: Boolean(policy?.enabled), folderPath, revision: policy?.revision ?? null });
	}
	assertCurrent();
	// Read after the requests, so a pause made meanwhile stays in place.
	await plugin.writeSettings({ reading: { ...plugin.settings.reading, folderPath } }, assertCurrent);
	assertCurrent();
	restartReading(plugin);
}
