import { readingServerRequest } from './server';
import { Notice, TFile, TFolder, type TAbstractFile } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { shouldIgnoreSyncPath } from '../sync/engine-ignore';
import { ReadingLibrary, type ReadingFile } from './data/library';
import { validateReadingFolder, type ReadingSettings } from './settings';

const runtimes = new WeakMap<CratePlugin, { library: ReadingLibrary; stop: () => void }>();
export function getReadingLibrary(plugin: CratePlugin): ReadingLibrary | undefined { return runtimes.get(plugin)?.library; }
export function stopReading(plugin: CratePlugin): void { runtimes.get(plugin)?.stop(); runtimes.delete(plugin); }

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
				const file = { path: entry.path, size: entry.stat.size, revision: `${fileIds.get(entry)}:${entry.stat.mtime}:${entry.stat.size}:${fileEvents.get(entry) ?? 0}` };
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
	const library = new ReadingLibrary({ files, read: async file => { const content = await vault.read(resolve(file)); resolve(file); return content; },
		process: (file, update) => vault.process(resolve(file), current => { resolve(file); return update(current); }),
		create: async (path, content) => {
      if (!policyChecked) throw new Error('Connect to your Crate server once to confirm the Reading folder before saving.');
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
	const refresh = () => {
		if (controller.signal.aborted || !plugin.app.workspace.layoutReady || plugin.syncRuntime.getState().status === 'syncing') return;

    if (plugin.settings.workerUrl && Date.now() - checkedAt > 60_000) {
      checkedAt = Date.now();
      void readingServerRequest<{ policy: { folder_path: string } | null }>(plugin, '/reading/policy').then(async ({ policy }) => {
        if (controller.signal.aborted) return;
        if (policy && policy.folder_path !== folder) {
          const reading = { ...plugin.settings.reading, folderPath: policy.folder_path };
          validateReadingConfiguration(plugin, reading); await plugin.writeSettings({ reading });
          if (!controller.signal.aborted) startReading(plugin); return;
        }
        policyChecked = true; schedule();
      }).catch(() => { /* Keep local data readable. Adoption waits for authoritative folder setup. */ });
    }
		void library.refresh().catch(() => { if (!controller.signal.aborted) new Notice('Could not refresh reading notes. Open reading for details.'); });
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
		controller.abort(); window.clearTimeout(timer);
		for (const ref of refs) vault.offref(ref);
		plugin.syncRuntime.removeStateChangeListener(schedule);
		lifetime.removeEventListener('abort', stop);
	};
	lifetime.addEventListener('abort', stop, { once: true });
	runtimes.set(plugin, { library, stop });
	plugin.app.workspace.onLayoutReady(() => { if (!controller.signal.aborted) schedule(); });
}
