import { Notice } from 'obsidian';
import type CratePlugin from '../main';
import { ActivityModal } from './activity-modal';

export function showSyncErrorNotice(plugin: CratePlugin, message: string): void {
	const content = createFragment();
	content.append(`${message} `);
	const link = createEl('a', { text: 'View errors', href: '#', cls: 'crate-sync-error-link' });
	content.append(link);
	const notice = new Notice(content, 10000);
	link.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		notice.hide();
		new ActivityModal(plugin.app, plugin.settings, plugin.syncRuntime, 'history').open();
	});
}
