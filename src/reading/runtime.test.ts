import { afterEach, describe, expect, it, vi } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { normalizeCrateSettings } from '../plugin/settings';
import { endPluginLifecycle } from '../plugin/lifecycle-state';
import { createReadingNote, updateReadingNote } from './core/notes';
import { getReadingLibrary, startReading, stopReading } from './runtime';

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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Reading runtime lifecycle', () => {
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
