import { readReadingPolicy, writeReadingPolicy } from './server';
import { captureServerConnection, isUnreachableServer } from '../plugin/server-request';
import { Notice, TFile, TFolder, type TAbstractFile } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { shouldIgnoreSyncPath, createIgnoreMatcherContext } from '../sync/local/ignore';
import { ReadingLibrary } from './data/library';
import { ReadingMaintenance } from './data/maintenance';
import { ReadingImageCleanup } from './data/image-cleanup';
import { createReadingRefresh } from './data/refresh-batch';
import { createObsidianReadingVault } from './data/obsidian-vault';
import { validateReadingFolder, type ReadingSettings } from './settings';
import { readingImageMode } from './core/article-images';
import { isMarkdownPath } from '@/protocol/note-paths';

export const READING_VIEW_TYPE = 'crate-reading';
/** Vault changes check the server's Reading folder at most this often; Complete server setup checks at once. */
const POLICY_RECHECK_MS = 60_000;

/** The plugin settings, vault, sync state and server credentials Reading runs on. */
type ReadingRuntimeHost = Pick<CratePlugin, 'app' | 'settings' | 'remindersSettings' | 'secretStorage' | 'syncRuntime' | 'writeSettings'>;

/** Reading state of one plugin instance. Only `runtime` ends with a stop; the rest outlives restarts. */
interface ReadingPluginState {
	/** The running library, replaced by every restart. */
	runtime?: {
		library: ReadingLibrary; stop: () => Promise<void>;
		/** Saves or adopts the server's Reading folder now; rejects when that fails. */
		checkSetup: () => Promise<void>;
		/** Why the last server folder check failed, until one succeeds. */
		setupError: () => string | undefined;
	};
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
/** The Reading folder check waits while sync writes files; it says nothing about the server. */
export class ReadingSetupBusyError extends Error {
	constructor() { super('Sync is updating files. Try again when it finishes.'); this.name = 'ReadingSetupBusyError'; }
}
/** Makes sure the connected server knows this vault's Reading folder. Does nothing while Reading is off or no server is connected. */
export function checkReadingSetup(plugin: ReadingRuntimeHost): Promise<void> {
	const runtime = states.get(plugin)?.runtime;
	if (!runtime || !plugin.settings.reading.enabled || !plugin.settings.workerUrl) return Promise.resolve();
	return runtime.checkSetup();
}
export function readingSetupError(plugin: ReadingRuntimeHost): string | undefined {
	return states.get(plugin)?.runtime?.setupError();
}
export async function waitForStoppedReading(plugin: ReadingRuntimeHost): Promise<void> { await states.get(plugin)?.stopping; }

// Compiled patterns are keyed by their text, so one cache serves every check.
const readingPatternCache = new Map<string, RegExp>();
// A folder listing checks every entry, so the matcher is built once per setting: saved
// settings replace the patterns array.
let readingMatcher: { configDir: string; patterns: string[]; context: ReturnType<typeof createIgnoreMatcherContext> } | undefined;
function allowedReadingPath(plugin: ReadingRuntimeHost, path: string): boolean {
	const configDir = plugin.app.vault.configDir, patterns = plugin.settings.ignorePatterns;
	if (readingMatcher?.configDir !== configDir || readingMatcher.patterns !== patterns) {
		readingMatcher = { configDir, patterns, context: createIgnoreMatcherContext([`${configDir}/`], patterns, readingPatternCache) };
	}
	return !shouldIgnoreSyncPath(path, readingMatcher.context);
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
		...{ captureArticle: async (url: string, signal: AbortSignal, id: string) => {
			const { captureDesktopArticle } = await import('./desktop-capture');
			const article = await captureDesktopArticle(url, signal);
			if (readingImageMode(plugin.settings.reading.images) !== 'save' || article.transcript) return article;
			const { saveDesktopArticleImages } = await import('./desktop-images');
			return saveDesktopArticleImages(article, { vault, folder, id, signal, allowed: path => allowedReadingPath(plugin, path) });
		} },
	}, folder, controller.signal, maintenance, startAfter);
	let lastErrorAt = 0;
	let policyCheck: Promise<void> | undefined;
	let setupError: string | undefined;
	// Adopting the server's folder restarts Reading, which a running download should not see change.
	const checkPolicy = (): Promise<void> => {
		if (policyCheck) return policyCheck;
		checkedAt = Date.now();
		const connection = captureServerConnection(plugin);
		policyCheck = reconcileReadingPolicy(plugin, folder, () => { controller.signal.throwIfAborted(); connection.assertCurrent(); }).then(adopted => {
			setupError = undefined;
			if (adopted) startReading(plugin);
			else { policyChecked = true; refresh.retry(); }
		}, (error: unknown) => {
			// Keep local data readable. Adoption waits for authoritative folder setup; an
			// unreachable server says nothing about it.
			if (!controller.signal.aborted && !isUnreachableServer(error)) setupError = error instanceof Error ? error.message : 'Could not set up Reading on the server.';
			throw error;
		}).finally(() => { policyCheck = undefined; });
		return policyCheck;
	};
	const checkSetup = () => {
		if (plugin.syncRuntime.isWritingVault()) return Promise.reject(new ReadingSetupBusyError());
		return checkPolicy();
	};
	const refresh = createReadingRefresh({
		maintenance, library, signal: controller.signal,
		canRun: () => plugin.app.workspace.layoutReady,
		beforeRefresh: () => {
			if (plugin.settings.workerUrl && !plugin.syncRuntime.isWritingVault() && Date.now() - checkedAt > POLICY_RECHECK_MS) void checkPolicy().catch(() => {});
		},
		onError: error => {
			if (Date.now() - lastErrorAt <= 60_000) return;
			lastErrorAt = Date.now();
			new Notice(error instanceof Error ? error.message : 'Could not refresh Reading.');
		},
	});
	// Sync progress updates change nothing Reading uses; status and vault writes do.
	let syncPhase = '';
	const onSyncStateChange = () => {
		const phase = `${plugin.syncRuntime.getState().status}:${plugin.syncRuntime.isWritingVault()}`;
		if (phase === syncPhase) return;
		syncPhase = phase;
		refresh.retry();
	};
	const inFolder = (path: string) => path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`);
	const changed = (path: string) => {
		if (!inFolder(path)) return;
		// The event changes the file's revision, and the note is read rather than taken from
		// Obsidian's frontmatter cache, which updates after the event. A path that is not a
		// note, such as a renamed folder, lists the folder again.
		readingVault.changed(path); library.invalidate(path);
		refresh.changed(path);
	};
	// Cards list only notes, so saved images and other files change none. A new folder is
	// empty; a moved or deleted one may hold notes and lists the folder again.
	const listable = (file: TAbstractFile) => !(file instanceof TFile) || isMarkdownPath(file.path);
	// Obsidian announces every existing file as created while it loads the vault; the first
	// listing after the layout is ready sees them anyway, so creates are heard from then on.
	const onCreate = (file: TAbstractFile) => { if (file instanceof TFile && listable(file)) changed(file.path); };
	const refs = [
		vault.on('modify', file => { if (listable(file)) changed(file.path); }),
		vault.on('delete', file => { if (listable(file)) changed(file.path); }),
		// A note moved into the folder is not re-indexed, so the background work checks it here.
		vault.on('rename', (file, oldPath) => {
			if (!listable(file) && !isMarkdownPath(oldPath)) return;
			changed(oldPath); changed(file.path); if (inFolder(file.path)) refresh.check(file.path);
		}),
	];
	// Obsidian re-indexes a note after every change, including notes changed while it was
	// closed; cards then take the fresh properties without reading the notes.
	const metadataRef = plugin.app.metadataCache.on('changed', file => {
		if (!inFolder(file.path)) return;
		refresh.reindexed(file.path);
	});
	// A deleted note's saved images go to the trash with it, also when sync deletes the note.
	const imageCleanup = new ReadingImageCleanup({
		folder, signal: controller.signal,
		busy: () => plugin.syncRuntime.isWritingVault(),
		noteIds: () => readingVault.files().map(file => {
			const properties = readingVault.cachedProperties(file);
			return properties ? typeof properties.crate_reading_id === 'string' ? properties.crate_reading_id : null : undefined;
		}),
		folderExists: path => vault.getAbstractFileByPath(path) instanceof TFolder,
		trash: async path => { const entry = vault.getAbstractFileByPath(path); if (entry instanceof TFolder) await plugin.app.fileManager.trashFile(entry); },
	});
	const deletedRef = plugin.app.metadataCache.on('deleted', (file, previous) => {
		if (file.path.startsWith(`${folder}/`)) imageCleanup.deleted(previous?.frontmatter?.crate_reading_id);
	});
	// Closing an editor lets waiting imports and highlight records proceed; other layout changes need no work.
	const layoutRef = plugin.app.workspace.on('layout-change', () => { if (maintenance.waitingForEditor) refresh.retry(); });
	plugin.syncRuntime.addStateChangeListener(onSyncStateChange);
	const stop = () => {
		controller.abort();
		for (const ref of refs) vault.offref(ref);
		plugin.app.workspace.offref(layoutRef);
		plugin.app.metadataCache.offref(metadataRef);
		plugin.app.metadataCache.offref(deletedRef);
		plugin.syncRuntime.removeStateChangeListener(onSyncStateChange);
		lifetime.removeEventListener('abort', onAbort);
		return Promise.allSettled([library.close(), maintenance.close(), refresh.stop()]).then(() => {});
	};
	const onAbort = () => { void stop(); };
	lifetime.addEventListener('abort', onAbort, { once: true });
	readingState(plugin).runtime = { library, stop, checkSetup, setupError: () => setupError };
	notifyRuntime(plugin);
	plugin.app.workspace.onLayoutReady(() => {
		if (controller.signal.aborted) return;
		refs.push(vault.on('create', onCreate));
		refresh.schedule();
	});
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
	if (plugin.settings.reading.enabled) republishReadingNotes(plugin, folderPath);
}

/** An encrypted vault lists only notes whose upload carried a Reading card, and a device adds
 * one only to a note in its Reading folder while Reading is on: notes already in the folder are
 * uploaded again so the web app lists them. */
export function republishReadingNotes(plugin: ReadingRuntimeHost, folder: string): void {
	void plugin.syncRuntime.republishFolderNotes(folder).catch((error: unknown) => {
		new Notice(`Reading notes in ${folder} will appear in the web app after their next edit. ${error instanceof Error ? error.message : ''}`.trim());
	});
}
