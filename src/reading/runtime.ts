import { loadEncryptionKeys } from '../plugin/encryption-storage';
import { captureAuthority, ReadingCaptureOutbox } from './data/capture-outbox';
import { getCheckpointAuthority } from '../sync/worker-url';
import { SECRET_KEYS } from '../plugin/settings-types';
import { readingServerRequest } from './server';
import { captureServerConnection } from '../plugin/server-request';
import { Notice, TFolder } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { shouldIgnoreSyncPath } from '../sync/engine-ignore';
import { ReadingLibrary } from './data/library';
import { createObsidianReadingVault } from './obsidian-vault';
import { validateReadingFolder, type ReadingSettings } from './settings';

const runtimes = new WeakMap<CratePlugin, { library: ReadingLibrary; stop: () => Promise<void> }>();
const stopping = new WeakMap<CratePlugin, Promise<void>>();
const listeners = new WeakMap<CratePlugin, Set<() => void>>();
export function subscribeReadingRuntime(plugin: CratePlugin, listener: () => void): () => void {
  let current = listeners.get(plugin);
  if (!current) { current = new Set(); listeners.set(plugin, current); }
  current.add(listener);
  return () => { current.delete(listener); };
}
function notifyRuntime(plugin: CratePlugin): void { listeners.get(plugin)?.forEach(listener => listener()); }
export function getReadingLibrary(plugin: CratePlugin): ReadingLibrary | undefined { return runtimes.get(plugin)?.library; }
export function stopReading(plugin: CratePlugin): void {
  const runtime = runtimes.get(plugin);
  if (runtime) stopping.set(plugin, Promise.allSettled([stopping.get(plugin), runtime.stop()]).then(() => {}));
  runtimes.delete(plugin); notifyRuntime(plugin);
}
export async function waitForStoppedReading(plugin: CratePlugin): Promise<void> { await stopping.get(plugin); }

// Compiled patterns are keyed by their text, so one cache serves every check.
const readingPatternCache = new Map<string, RegExp>();
function allowedReadingPath(plugin: CratePlugin, path: string): boolean {
	return !shouldIgnoreSyncPath(path, {
		ignoredDirPrefixes: [...plugin.settings.ignorePatterns.filter(pattern => pattern.endsWith('/')), `${plugin.app.vault.configDir}/`],
		ignorePatterns: plugin.settings.ignorePatterns, patternCache: readingPatternCache,
	});
}

export function validateReadingConfiguration(plugin: CratePlugin, settings: ReadingSettings): string {
	const folder = validateReadingFolder(settings.folderPath, plugin.remindersSettings.remindersFolderPath, plugin.app.vault.configDir);
	if (!allowedReadingPath(plugin, `${folder}/reading.md`)) throw new Error('The reading folder is excluded from sync. Choose a folder that can sync.');
	const existing = plugin.app.vault.getAbstractFileByPath(folder);
	if (existing && !(existing instanceof TFolder)) throw new Error('The reading folder path is already a file.');
	return folder;
}

export function startReading(plugin: CratePlugin): void {
	stopReading(plugin);
	if (!plugin.settings.reading.enabled || plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) return;
	const lifetime = getPluginLifecycleSignal(plugin);
	lifetime.throwIfAborted();
	const folder = validateReadingConfiguration(plugin, plugin.settings.reading);
	const controller = new AbortController();
	const { vault } = plugin.app;
	const readingVault = createObsidianReadingVault(vault, folder, {
		signal: controller.signal,
		allowed: path => allowedReadingPath(plugin, path),
		validate: () => { validateReadingConfiguration(plugin, plugin.settings.reading); },
	});
	let policyChecked = !plugin.settings.workerUrl;
 let checkedAt = 0;
	const canAdopt = () => policyChecked && plugin.app.workspace.layoutReady && !['syncing', 'error', 'offline'].includes(plugin.syncRuntime.getState().status);
	let outboxPromise: Promise<ReadingCaptureOutbox> | undefined;
	const outbox = () => outboxPromise ??= (async () => {
		const origin = plugin.settings.workerUrl, token = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN);
		const scope = loadEncryptionKeys(plugin.secretStorage) ? getCheckpointAuthority(plugin.settings) : origin;
		const authority = await captureAuthority(scope, token), alias = await captureAuthority(origin, token);
		controller.signal.throwIfAborted();
		const directory = `${vault.configDir}/plugins/${plugin.manifest.id}/reading-captures`;
		const guard = () => {
			controller.signal.throwIfAborted();
			if (getCheckpointAuthority(plugin.settings) !== scope || plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== token) throw new Error('The Reading server connection changed. Reopen Reading.');
		};
		return new ReadingCaptureOutbox({
			list: async () => { guard(); return await vault.adapter.exists(directory) ? (await vault.adapter.list(directory)).files.filter(path => path.endsWith('.json')).map(path => path.slice(directory.length + 1)) : []; },
			read: async key => { guard(); return vault.adapter.read(`${directory}/${key}`); },
			write: async (key, value) => {
				guard(); if (!await vault.adapter.exists(directory)) await vault.adapter.mkdir(directory);
				guard(); await vault.adapter.write(`${directory}/${key}`, value);
				if (await vault.adapter.read(`${directory}/${key}`) !== value) throw new Error('Could not verify the saved Reading link.');
			},
			remove: async (key, operationId) => {
				guard();
				const { removeEncryptedReadingCapture } = await import('./encrypted-capture');
				await removeEncryptedReadingCapture(plugin, operationId);
				guard(); await vault.adapter.remove(`${directory}/${key}`);
			},
		}, authority, folder, controller.signal, [alias]);
	})();
	// Keep replacement views synchronous, but start their vault work after the old library drains.
	const library = new ReadingLibrary({ ...readingVault, privateFilenames: () => Boolean(loadEncryptionKeys(plugin.secretStorage)),
		...{ captureArticle: async (url: string, signal: AbortSignal) => {
			const { captureDesktopArticle } = await import('./desktop-capture');
			return captureDesktopArticle(url, signal);
		} },
		...(plugin.settings.workerUrl ? {
			pendingCaptures: async () => (await outbox()).list(),
			queueCapture: async (url: string, title?: string) => { const item = await (await outbox()).add(url, title); schedule(); return item; },
		} : {}),
	}, folder, controller.signal, canAdopt, stopping.get(plugin));
	let timer: number | undefined;
	let lastErrorAt = 0;
	let draining = false;
  const refreshes = new Set<Promise<void>>();
  const attemptedArticles = new Set<string>();
	const polling = plugin.settings.workerUrl ? window.setInterval(() => { if (library.getSnapshot().items.some(item => !item.path)) schedule(); }, 15_000) : undefined;
	if (polling !== undefined) plugin.registerInterval(polling);
	const refresh = () => {
		if (controller.signal.aborted || !plugin.app.workspace.layoutReady || plugin.syncRuntime.getState().status === 'syncing') return;

    if (plugin.settings.workerUrl && Date.now() - checkedAt > 60_000) {
      checkedAt = Date.now();
      void (async () => {
        const connection = captureServerConnection(plugin);
        const assertCurrent = () => { controller.signal.throwIfAborted(); connection.assertCurrent(); };
        const { policy } = await readingServerRequest<{ policy: { folder_path: string; enabled: number; revision: string } | null }>(plugin, '/reading/policy');
        assertCurrent();
        if (!policy || !policy.enabled) {
          await readingServerRequest(plugin, '/reading/policy', { enabled: true, folderPath: policy?.folder_path ?? folder, revision: policy?.revision ?? null });
          assertCurrent();
        }
        if (policy && policy.folder_path !== folder) {
          const reading = { ...plugin.settings.reading, folderPath: policy.folder_path };
          validateReadingConfiguration(plugin, reading); await plugin.writeSettings({ reading }, assertCurrent);
          assertCurrent(); startReading(plugin); return;
        }
        policyChecked = true; schedule();
      })().catch(() => { /* Keep local data readable. Adoption waits for authoritative folder setup. */ });
    }
		const work = library.refresh().then(async () => {
      if (loadEncryptionKeys(plugin.secretStorage) && canAdopt()) {
        const item = library.getSnapshot().items.find(item => item.path && item.extraction_status === 'pending' && !attemptedArticles.has(item.crate_reading_id));
        if (item) { attemptedArticles.add(item.crate_reading_id); void library.retryCapture(item).catch(() => {}).finally(schedule); }
      }
			if (!plugin.settings.workerUrl || !policyChecked || controller.signal.aborted || draining) return;
			draining = true;
			try { await (await outbox()).drain(library.getSnapshot().items, body => readingServerRequest(plugin, '/reading/capture', body)); } finally { draining = false; }
		}).catch(error => { if (!controller.signal.aborted && Date.now() - lastErrorAt > 60_000) { lastErrorAt = Date.now(); new Notice(error instanceof Error ? error.message : 'Could not finish pending Reading saves.'); } });
    refreshes.add(work); void work.finally(() => refreshes.delete(work));
	};
	const schedule = () => {
		if (controller.signal.aborted) return;
		window.clearTimeout(timer); timer = window.setTimeout(refresh, 400);
	};
	const inFolder = (path: string) => path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`);
	const changed = (path: string) => {
		if (!inFolder(path)) return;
		readingVault.changed(path);
		library.invalidate(path); schedule();
	};
	const refs = [
		vault.on('create', file => { changed(file.path); }),
		vault.on('modify', file => { changed(file.path); }),
		vault.on('delete', file => { changed(file.path); }),
		vault.on('rename', (file, oldPath) => { changed(oldPath); changed(file.path); }),
	];
	for (const ref of refs) plugin.registerEvent(ref);
	plugin.syncRuntime.addStateChangeListener(schedule);
	const stop = () => {
		controller.abort(); window.clearTimeout(timer); window.clearInterval(polling);
		for (const ref of refs) vault.offref(ref);
		plugin.syncRuntime.removeStateChangeListener(schedule);
		lifetime.removeEventListener('abort', onAbort);
    return Promise.allSettled([library.close(), ...refreshes, outboxPromise?.then(box => box.waitForIdle())]).then(() => {});
	};
  const onAbort = () => { void stop(); };
	lifetime.addEventListener('abort', onAbort, { once: true });
	runtimes.set(plugin, { library, stop });
	notifyRuntime(plugin);
	plugin.app.workspace.onLayoutReady(() => { if (!controller.signal.aborted) schedule(); });
}
