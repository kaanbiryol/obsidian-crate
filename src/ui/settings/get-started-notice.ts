import { Notice } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';

/** One notice on a fresh install that points to the checklist. */
export function showGetStartedNotice(plugin: CratePlugin): void {
	if (!plugin.firstRun || plugin.syncRuntime.isConfigured()) return;
	// Saving creates the plugin data, so the next start is no longer a first run.
	void plugin.saveSettings().catch(() => {});
	const fragment = new DocumentFragment();
	fragment.createSpan({ text: 'Crate is installed. ' });
	const link = fragment.createEl('a', { text: 'Open settings' });
	link.addEventListener('click', () => { plugin.openSettingsTab(); });
	fragment.createSpan({ text: ' to get started.' });
	new Notice(fragment, 15000);
}
