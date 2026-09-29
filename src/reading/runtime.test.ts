import { captureDesktopArticle } from './desktop-capture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform, TFile, TFolder } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { normalizeCrateSettings } from '../plugin/settings';
import { endPluginLifecycle } from '../plugin/lifecycle-state';
import { createReadingNote, parseReadingNote, updateReadingNote } from './core/notes';
import { getReadingLibrary, startReading, stopReading, subscribeReadingRuntime } from './runtime';
import { readingServerRequest } from './server';

vi.mock('./desktop-capture', () => ({ captureDesktopArticle: vi.fn(async () => ({ markdown: 'Downloaded article text from the desktop.', title: 'Desktop article' })) }));
vi.mock('./server', () => ({ readingServerRequest: vi.fn() }));

function harness() {
	vi.useFakeTimers(); vi.stubGlobal('window', globalThis);
	const file = Object.assign(new TFile(), { path: 'Reading/article.md', extension: 'md', stat: { size: 400, mtime: 1, ctime: 1 } });
	const root = Object.assign(new TFolder(), { path: 'Reading', children: [file] });
	let content = createReadingNote({ id: '0cf86c65-51e2-4e2b-8987-0a4732473588', url: 'https://example.com', savedAt: '2026-09-21T12:00:00Z' });
	const events = new Map<string, Set<(file: TFile, oldPath?: string) => void>>();
	const syncListeners = new Set<() => void>();
	const callbacks: (() => void)[] = [];
	let status = 'idle';
	const vault = {
		configDir: '.obsidian', getAbstractFileByPath: (path: string) => path === root.path ? root : path === file.path ? file : null,
		read: vi.fn(async () => content), process: vi.fn(async (_file: TFile, update: (content: string) => string) => { content = update(content); return content; }),
		on: (name: string, callback: (file: TFile, oldPath?: string) => void) => {
			if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(callback); return { name, callback };
		}, offref: (ref: { name: string; callback: (file: TFile, oldPath?: string) => void }) => { events.get(ref.name)!.delete(ref.callback); },
	};
	const workspace = { layoutReady: false, onLayoutReady: (callback: () => void) => { callbacks.push(callback); if (workspace.layoutReady) callback(); } };
	const plugin = { settings: normalizeCrateSettings({ reading: { enabled: true, folderPath: 'Reading' } }, '.obsidian'),
		remindersSettings: { remindersFolderPath: 'Reminders' }, app: { vault, workspace }, registerEvent: vi.fn(),
		syncRuntime: { getState: () => ({ status }), addStateChangeListener: (listener: () => void) => { syncListeners.add(listener); }, removeStateChangeListener: (listener: () => void) => { syncListeners.delete(listener); } },
	} as unknown as CratePlugin;
	return { plugin, file, vault, workspace, callbacks, events, syncListeners,
		setStatus: (next: string) => { status = next; for (const listener of syncListeners) listener(); },
		edit: (update: (source: string) => string) => { content = update(content); for (const listener of events.get('modify') ?? []) listener(file); },
	};
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Reading runtime lifecycle', () => {
  it.each(['missing', 'different folder'])('discards an old server’s %s policy before mutation or local save', async kind => {
    const h = harness();
    h.plugin.settings.workerUrl = 'https://original.example';
    h.workspace.layoutReady = true;
    const writeSettings = vi.fn();
    Object.assign(h.plugin, { secretStorage: { get: () => 'synthetic' }, registerInterval: vi.fn(), writeSettings });
    vi.mocked(readingServerRequest).mockImplementationOnce(async () => {
      h.plugin.settings.workerUrl = 'https://replacement.example';
      return { policy: kind === 'missing' ? null : { enabled: 1, folder_path: 'Other reading', revision: 'old' } };
    });
    startReading(h.plugin);
    try {
      await vi.advanceTimersByTimeAsync(400);
      expect(readingServerRequest).toHaveBeenCalledOnce();
      expect(writeSettings).not.toHaveBeenCalled();
      expect(h.plugin.settings.reading.folderPath).toBe('Reading');
    } finally { stopReading(h.plugin); }
  });
  it('saves and extracts on desktop before checking a configured server policy', async () => {
    const h = harness(), saved = new Map<string, string>();
    const root = h.vault.getAbstractFileByPath('Reading');
    if (!(root instanceof TFolder)) throw new Error('Missing test folder');
    const lookup = h.vault.getAbstractFileByPath;
    Object.assign(h.vault, {
      adapter: { exists: async () => false },
      getAllLoadedFiles: () => root.children,
      getAbstractFileByPath: (path: string) => root.children.find(file => file.path === path) ?? lookup(path),
      create: async (path: string, content: string) => {
        saved.set(path, content);
        root.children.push(Object.assign(new TFile(), { path, extension: 'md', stat: { size: content.length, mtime: 2, ctime: 2 } }));
      },
    });
    const read = h.vault.read.getMockImplementation()!;
    h.vault.read.mockImplementation(async (file?: TFile) => file && saved.has(file.path) ? saved.get(file.path)! : read());
    const process = h.vault.process.getMockImplementation()!;
    h.vault.process.mockImplementation(async (file, update) => {
      if (!saved.has(file.path)) return process(file, update);
      const content = update(saved.get(file.path)!); saved.set(file.path, content); return content;
    });
    h.plugin.settings.workerUrl = 'https://crate.example.com';
    Object.assign(h.plugin, { secretStorage: { get: () => 'device-token' }, manifest: { id: 'crate' }, registerInterval: vi.fn() });
    startReading(h.plugin);
    const library = getReadingLibrary(h.plugin)!;
    const { item } = await library.add('https://example.com/desktop');
    await library.retryCapture(item);
    expect(parseReadingNote(saved.get(item.path)!)).toMatchObject({ title: 'Desktop article', extraction_status: 'ready' });
    expect(captureDesktopArticle).toHaveBeenCalledWith('https://example.com/desktop', expect.any(AbortSignal));
    stopReading(h.plugin);
  });
  it('retains server capture on mobile', () => {
    const h = harness();
    const desktop = Platform.isDesktopApp;
    try {
      Platform.isDesktopApp = false;
      startReading(h.plugin);
      expect(getReadingLibrary(h.plugin)!.canCaptureLocally).toBe(false);
    } finally { Platform.isDesktopApp = desktop; stopReading(h.plugin); }
  });
  it('updates mounted workspaces when the local library is replaced or stopped', () => {
    const h = harness();
    const listener = vi.fn(() => getReadingLibrary(h.plugin));
    const unsubscribe = subscribeReadingRuntime(h.plugin, listener);
    startReading(h.plugin);
    const first = getReadingLibrary(h.plugin);
    expect(listener).toHaveLastReturnedWith(first);
    startReading(h.plugin);
    expect(getReadingLibrary(h.plugin)).not.toBe(first);
    expect(listener).toHaveLastReturnedWith(getReadingLibrary(h.plugin));
    stopReading(h.plugin);
    expect(listener).toHaveLastReturnedWith(undefined);
    unsubscribe(); listener.mockClear();
    startReading(h.plugin);
    expect(listener).not.toHaveBeenCalled();
    stopReading(h.plugin);
  });
	it('discovers a normal clip after the vault is ready without a template marker', async () => {
		const h = harness();
		h.edit(() => '---\nsource: https://example.com/article\nauthor:\n---\nClipped text.');
		h.workspace.layoutReady = true; startReading(h.plugin);
		await vi.advanceTimersByTimeAsync(500);
		await getReadingLibrary(h.plugin)!.refresh();
		expect(getReadingLibrary(h.plugin)!.getSnapshot().issues).toEqual([]);
		expect(getReadingLibrary(h.plugin)!.getSnapshot().items[0]).toMatchObject({ title: 'article', source_url: 'https://example.com/article', reading_status: 'inbox', favorite: false });
		expect(h.vault.process).toHaveBeenCalledTimes(1);
		stopReading(h.plugin);
	});
	it('waits for the vault and startup sync, then cancels every watcher on unload', async () => {
		const h = harness(); startReading(h.plugin);
		await vi.advanceTimersByTimeAsync(500); expect(h.vault.read).not.toHaveBeenCalled();
		h.setStatus('syncing'); h.workspace.layoutReady = true; h.callbacks[0]!();
		await vi.advanceTimersByTimeAsync(500); expect(h.vault.read).not.toHaveBeenCalled();
		expect(getReadingLibrary(h.plugin)?.getSnapshot().loading).toBe(true);
		h.setStatus('idle'); await vi.advanceTimersByTimeAsync(500);
		expect(getReadingLibrary(h.plugin)?.getSnapshot().items).toHaveLength(1);
		h.edit(source => source + '\nPersonal note.');
		endPluginLifecycle(h.plugin); await vi.advanceTimersByTimeAsync(500);
		expect(h.vault.read).toHaveBeenCalledTimes(1);
		expect(h.syncListeners.size).toBe(0);
		for (const listeners of h.events.values()) expect(listeners.size).toBe(0);
	});
	it('invalidates equal-timestamp edits and avoids duplicate watchers when restarted', async () => {
		const h = harness(); h.workspace.layoutReady = true; startReading(h.plugin);
		await vi.advanceTimersByTimeAsync(500);
		const item = getReadingLibrary(h.plugin)!.getSnapshot().items[0]!;
		h.edit(source => updateReadingNote(source, item.crate_reading_id, { favorite: true }));
		await vi.advanceTimersByTimeAsync(500);
		expect(getReadingLibrary(h.plugin)!.getSnapshot().items[0]?.favorite).toBe(true);
		startReading(h.plugin);
		expect(h.syncListeners.size).toBe(1);
		for (const listeners of h.events.values()) expect(listeners.size).toBe(1);
		stopReading(h.plugin); expect(getReadingLibrary(h.plugin)).toBeUndefined();
		for (const listeners of h.events.values()) expect(listeners.size).toBe(0);
	});
	it('rejects overlapping or ignored folders before reading or writing any note', () => {
		const h = harness(); h.plugin.settings.ignorePatterns = ['Reading/'];
		expect(() => startReading(h.plugin)).toThrow('excluded');
		h.plugin.settings.ignorePatterns = []; h.plugin.settings.reading.folderPath = 'Reminders/Reading';
		expect(() => startReading(h.plugin)).toThrow('separate');
		expect(h.vault.read).not.toHaveBeenCalled(); expect(h.vault.process).not.toHaveBeenCalled();
	});
});
