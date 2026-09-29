import { ReadingCaptureOutbox } from './data/capture-outbox';
import { SECRET_KEYS } from '../plugin/settings-types';
import { portablePathKey } from '@/protocol/portable-path';
import { readingServerRequest } from './server';
import { captureServerConnection } from '../plugin/server-request';
import { Notice, Platform, TFile, TFolder, type TAbstractFile } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { shouldIgnoreSyncPath } from '../sync/engine-ignore';
import { ReadingLibrary, type ReadingFile } from './data/library';
import { validateReadingFolder, type ReadingSettings } from './settings';

const runtimes = new WeakMap<CratePlugin, { library: ReadingLibrary; stop: () => void }>();
const listeners = new WeakMap<CratePlugin, Set<() => void>>();
export function subscribeReadingRuntime(plugin: CratePlugin, listener: () => void): () => void {
  let current = listeners.get(plugin);
  if (!current) { current = new Set(); listeners.set(plugin, current); }
  current.add(listener);
  return () => { current.delete(listener); };
}
function notifyRuntime(plugin: CratePlugin): void { listeners.get(plugin)?.forEach(listener => listener()); }
export function getReadingLibrary(plugin: CratePlugin): ReadingLibrary | undefined { return runtimes.get(plugin)?.library; }
export function stopReading(plugin: CratePlugin): void { runtimes.get(plugin)?.stop(); runtimes.delete(plugin); notifyRuntime(plugin); }

function allowedReadingPath(plugin: CratePlugin, path: string): boolean {
	return !shouldIgnoreSyncPath(path, {
		ignoredDirPrefixes: [...plugin.settings.ignorePatterns.filter(pattern => pattern.endsWith('/')), `${plugin.app.vault.configDir}/`],
		ignorePatterns: plugin.settings.ignorePatterns, patternCache: new Map(),
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
	if (!plugin.settings.reading.enabled) return;
	const lifetime = getPluginLifecycleSignal(plugin);
	lifetime.throwIfAborted();
	const folder = validateReadingConfiguration(plugin, plugin.settings.reading);
	const controller = new AbortController();
	const { vault } = plugin.app;
	const fileRefs = new WeakMap<ReadingFile, TFile>();
	const fileIds = new WeakMap<TFile, number>();
	const fileEvents = new WeakMap<TFile, number>();
	let nextFileId = 0;
	const allowed = (path: string) => allowedReadingPath(plugin, path);
	const files = (): ReadingFile[] => {
		validateReadingConfiguration(plugin, plugin.settings.reading);
		const result: ReadingFile[] = [];
		const walk = (entry: TAbstractFile) => {
			if (!allowed(entry.path)) return;
			if (entry instanceof TFolder) for (const child of entry.children) walk(child);
			else if (entry instanceof TFile && entry.extension.toLowerCase() === 'md') {
				if (!fileIds.has(entry)) fileIds.set(entry, ++nextFileId);
				const file = { path: entry.path, size: entry.stat.size, modifiedAt: entry.stat.mtime, revision: `${fileIds.get(entry)}:${entry.stat.mtime}:${entry.stat.size}:${fileEvents.get(entry) ?? 0}` };
				fileRefs.set(file, entry); result.push(file);
			}
		};
		const root = vault.getAbstractFileByPath(folder);
		if (root) walk(root);
		return result;
	};
	const resolve = (file: ReadingFile): TFile => {
		const ref = fileRefs.get(file);
		if (!ref || vault.getAbstractFileByPath(file.path) !== ref || ref.path !== file.path || !allowed(file.path)) throw new Error('Reading note moved, was deleted, or is excluded from sync.');
		return ref;
	};
	let policyChecked = !plugin.settings.workerUrl;
 let checkedAt = 0;
	const canAdopt = () => policyChecked && plugin.app.workspace.layoutReady && !['syncing', 'error', 'offline'].includes(plugin.syncRuntime.getState().status);
	let outboxPromise: Promise<ReadingCaptureOutbox> | undefined;
	const outbox = () => outboxPromise ??= (async () => {
		const origin = plugin.settings.workerUrl, token = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN);
		const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([origin, token])));
		controller.signal.throwIfAborted();
		const authority = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
		const directory = `${vault.configDir}/plugins/${plugin.manifest.id}/reading-captures`;
		const guard = () => {
			controller.signal.throwIfAborted();
			if (plugin.settings.workerUrl !== origin || plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== token) throw new Error('The Reading server connection changed. Reopen Reading.');
		};
		return new ReadingCaptureOutbox({
			list: async () => { guard(); return await vault.adapter.exists(directory) ? (await vault.adapter.list(directory)).files.filter(path => path.endsWith('.json')).map(path => path.slice(directory.length + 1)) : []; },
			read: async key => { guard(); return vault.adapter.read(`${directory}/${key}`); },
			write: async (key, value) => {
				guard(); if (!await vault.adapter.exists(directory)) await vault.adapter.mkdir(directory);
				guard(); await vault.adapter.write(`${directory}/${key}`, value);
				if (await vault.adapter.read(`${directory}/${key}`) !== value) throw new Error('Could not verify the saved Reading link.');
			},
			remove: async key => { guard(); await vault.adapter.remove(`${directory}/${key}`); },
		}, authority, folder, controller.signal);
	})();
	const library = new ReadingLibrary({ files,
		...(Platform.isDesktopApp ? { captureArticle: async (url: string, signal: AbortSignal) => {
			const { captureDesktopArticle } = await import('./desktop-capture');
			return captureDesktopArticle(url, signal);
		} } : {}),
		occupied: path => vault.getAllLoadedFiles().some(file => portablePathKey(file.path) === portablePathKey(path)),
		...(plugin.settings.workerUrl ? {
			pendingCaptures: async () => (await outbox()).list(),
			queueCapture: async (url: string, title?: string) => { const item = await (await outbox()).add(url, title); schedule(); return item; },
		} : {}),
		read: async file => { const content = await vault.read(resolve(file)); resolve(file); return content; },
		process: (file, update) => vault.process(resolve(file), current => { resolve(file); return update(current); }),
		create: async (path, content) => {
      if (!policyChecked && !Platform.isDesktopApp) throw new Error('Connect to your Crate server once to confirm the Reading folder before saving.');
			const segments = folder.split('/');
			for (let i = 1; i <= segments.length; i++) {
				controller.signal.throwIfAborted();
				const part = segments.slice(0, i).join('/');
				if (!vault.getAbstractFileByPath(part)) {
					try { await vault.createFolder(part); } catch (error) { if (!(vault.getAbstractFileByPath(part) instanceof TFolder)) throw error; }
				}
			}
			controller.signal.throwIfAborted();
			if (!allowed(path)) throw new Error('Reading folder is excluded from sync.');
			await vault.create(path, content);
		},
	}, folder, controller.signal, canAdopt);
	let timer: number | undefined;
	let lastErrorAt = 0;
	let draining = false;
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
		void library.refresh().then(async () => {
			if (!plugin.settings.workerUrl || !policyChecked || controller.signal.aborted || draining) return;
			draining = true;
			try { await (await outbox()).drain(library.getSnapshot().items, body => readingServerRequest(plugin, '/reading/capture', body)); } finally { draining = false; }
		}).catch(error => { if (!controller.signal.aborted && Date.now() - lastErrorAt > 60_000) { lastErrorAt = Date.now(); new Notice(error instanceof Error ? error.message : 'Could not finish pending Reading saves.'); } });
	};
	const schedule = () => {
		if (controller.signal.aborted) return;
		window.clearTimeout(timer); timer = window.setTimeout(refresh, 400);
	};
	const inFolder = (path: string) => path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`);
	const changed = (path: string) => {
		if (!inFolder(path)) return;
		const file = vault.getAbstractFileByPath(path);
		if (file instanceof TFile) fileEvents.set(file, (fileEvents.get(file) ?? 0) + 1);
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
		lifetime.removeEventListener('abort', stop);
	};
	lifetime.addEventListener('abort', stop, { once: true });
	runtimes.set(plugin, { library, stop });
	notifyRuntime(plugin);
	plugin.app.workspace.onLayoutReady(() => { if (!controller.signal.aborted) schedule(); });
}
