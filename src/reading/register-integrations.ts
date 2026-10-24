import { Notice } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { READING_VIEW_TYPE, requestReadingItem, startReading, stopReading } from './runtime';
import { AddReadingLinkModal } from './ui/plugin/add-link-modal';
import { ReadingView } from './ui/plugin/reading-view';

const READING_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function openReading(plugin: CratePlugin, itemId?: string): Promise<void> {
	if (!plugin.settings.reading.enabled) { new Notice('Enable reading in Crate settings first.'); return; }
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return;
	if (itemId) requestReadingItem(plugin, itemId);
	const leaf = plugin.app.workspace.getLeavesOfType(READING_VIEW_TYPE)[0] ?? plugin.app.workspace.getLeaf('tab');
	await leaf.setViewState({ type: READING_VIEW_TYPE, active: true });
	if (!signal.aborted) await plugin.app.workspace.revealLeaf(leaf);
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
	try { startReading(plugin); }
	catch (error) { new Notice(error instanceof Error ? error.message : 'Could not start reading.'); }
}
