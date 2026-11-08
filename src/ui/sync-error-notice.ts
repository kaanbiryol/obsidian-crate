import { Notice } from 'obsidian';

let lastShownAt = 0;

/** A background-failure notice and a Sync now notice for the same run show once. */
export function showSyncErrorNotice(message: string, viewErrors: () => void): void {
	if (Date.now() - lastShownAt < 2000) return;
	lastShownAt = Date.now();
	const content = createFragment();
	content.append(`${message} `);
	const link = createEl('a', { text: 'View errors', href: '#', cls: 'crate-sync-error-link' });
	content.append(link);
	const notice = new Notice(content, 10000);
	link.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		notice.hide();
		viewErrors();
	});
}
