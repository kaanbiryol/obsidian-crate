import { Notice, type MarkdownView, type TAbstractFile, TFile, type WorkspaceLeaf } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { READING_VIEW_TYPE, requestReadingItem, startReading, stopReading } from './runtime';
import { AddReadingLinkModal } from './ui/plugin/add-link-modal';
import { ReadingView } from './ui/plugin/reading-view';

const READING_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function openReading(plugin: CratePlugin, itemId?: string, replace?: WorkspaceLeaf): Promise<void> {
	if (!plugin.settings.reading.enabled) { new Notice('Enable reading in Crate settings first.'); return; }
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return;
	if (itemId) requestReadingItem(plugin, itemId);
	const leaf = plugin.app.workspace.getLeavesOfType(READING_VIEW_TYPE)[0] ?? replace ?? plugin.app.workspace.getLeaf('tab');
	await leaf.setViewState({ type: READING_VIEW_TYPE, active: true });
	if (!signal.aborted) await plugin.app.workspace.revealLeaf(leaf);
}

/** The reading id of a note in the reading folder. The reader verifies the identity when it opens the item. */
export function readingIdForFile(plugin: CratePlugin, file: TAbstractFile | null): string | undefined {
	if (!plugin.settings.reading.enabled || !(file instanceof TFile) || file.extension !== 'md') return;
	if (!file.path.startsWith(`${plugin.settings.reading.folderPath.trim()}/`)) return;
	const id: unknown = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.crate_reading_id;
	return typeof id === 'string' && READING_ID.test(id) ? id.toLowerCase() : undefined;
}

// Reuses an open reader. Otherwise the reader takes over the note's tab, so the open editor does not hold back highlight writes.
function openFileInReader(plugin: CratePlugin, file: TAbstractFile | null, leaf?: WorkspaceLeaf): void {
	const id = readingIdForFile(plugin, file);
	if (!id) return;
	const source = leaf?.view.getViewType() === 'markdown' && (leaf.view as MarkdownView).file === file ? leaf : undefined;
	void openReading(plugin, id, source).catch(() => { new Notice('Could not open reading. Please try again.'); });
}

function registerReaderHeaderActions(plugin: CratePlugin): void {
	const actions = new Map<MarkdownView, HTMLElement>();
	const refresh = () => {
		const views = new Set(plugin.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view as MarkdownView));
		for (const [view, action] of actions) {
			if (views.has(view) && readingIdForFile(plugin, view.file)) continue;
			action.remove(); actions.delete(view);
		}
		for (const view of views) {
			if (actions.has(view) || !readingIdForFile(plugin, view.file)) continue;
			actions.set(view, view.addAction('book-open', 'Open in reader', () => { openFileInReader(plugin, view.file, view.leaf); }));
		}
	};
	plugin.registerEvent(plugin.app.workspace.on('layout-change', refresh));
	plugin.registerEvent(plugin.app.workspace.on('file-open', refresh));
	plugin.registerEvent(plugin.app.metadataCache.on('changed', refresh));
	plugin.app.workspace.onLayoutReady(refresh);
	plugin.register(() => { for (const action of actions.values()) action.remove(); actions.clear(); });
}

export function registerReading(plugin: CratePlugin): void {
	plugin.register(() => stopReading(plugin));
	plugin.registerView(READING_VIEW_TYPE, leaf => new ReadingView(leaf, plugin));
	plugin.addCommand({ id: 'open-reading', name: 'Open reading library', callback: () => openReading(plugin) });
	// The save page links here after a shortcut save. Sync brings the new note in.
	plugin.registerObsidianProtocolHandler('crate-reading', params => {
		plugin.syncRuntime.triggerForegroundSync('visible');
		void openReading(plugin, params.item && READING_ID.test(params.item) ? params.item.toLowerCase() : undefined)
			.catch(() => { new Notice('Could not open reading. Please try again.'); });
	});
	plugin.addCommand({ id: 'add-reading-link', name: 'Add link to reading list', callback: () => {
		if (!plugin.settings.reading.enabled) { new Notice('Enable reading in Crate settings first.'); return; }
		new AddReadingLinkModal(plugin).open();
	} });
	plugin.addCommand({ id: 'open-note-in-reader', name: 'Open current note in reader', checkCallback: checking => {
		const file = plugin.app.workspace.getActiveFile();
		if (!readingIdForFile(plugin, file)) return false;
		if (!checking) openFileInReader(plugin, file, plugin.app.workspace.getMostRecentLeaf() ?? undefined);
		return true;
	} });
	plugin.registerEvent(plugin.app.workspace.on('file-menu', (menu, file, _source, leaf) => {
		if (!readingIdForFile(plugin, file)) return;
		menu.addItem(item => item.setTitle('Open in reader').setIcon('book-open').onClick(() => { openFileInReader(plugin, file, leaf); }));
	}));
	registerReaderHeaderActions(plugin);
	try { startReading(plugin); }
	catch (error) { new Notice(error instanceof Error ? error.message : 'Could not start reading.'); }
}
