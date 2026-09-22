import { Notice } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { startReading, stopReading } from './runtime';
import { AddReadingLinkModal } from './ui/add-link-modal';
import { READING_VIEW_TYPE, ReadingView } from './ui/reading-view';

export async function openReading(plugin: CratePlugin): Promise<void> {
	if (!plugin.settings.reading.enabled) { new Notice('Enable reading in Crate settings first.'); plugin.openSettingsTab(); return; }
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return;
	const leaf = plugin.app.workspace.getLeavesOfType(READING_VIEW_TYPE)[0] ?? plugin.app.workspace.getLeaf('tab');
	await leaf.setViewState({ type: READING_VIEW_TYPE, active: true });
	if (!signal.aborted) await plugin.app.workspace.revealLeaf(leaf);
}

export function registerReading(plugin: CratePlugin): void {
	plugin.register(() => stopReading(plugin));
	plugin.registerView(READING_VIEW_TYPE, leaf => new ReadingView(leaf, plugin));
	plugin.addCommand({ id: 'open-reading', name: 'Open reading', callback: () => openReading(plugin) });
	plugin.addCommand({ id: 'add-reading-link', name: 'Add reading link', callback: () => {
		if (!plugin.settings.reading.enabled) { new Notice('Enable reading in Crate settings first.'); plugin.openSettingsTab(); return; }
		new AddReadingLinkModal(plugin).open();
	} });
	try { startReading(plugin); }
	catch (error) { new Notice(error instanceof Error ? error.message : 'Could not start reading.'); }
}
