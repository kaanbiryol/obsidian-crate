import { setIcon } from 'obsidian';

export type FileCardType = 'upload' | 'download' | 'merge' | 'delete' | 'conflict';

const FILE_CARD_ICONS: Record<FileCardType, string> = {
	upload: 'upload',
	download: 'download',
	merge: 'git-merge',
	delete: 'trash-2',
	conflict: 'alert-triangle',
};

export function renderFileMicroCard(
	container: HTMLElement,
	filePath: string,
	type: FileCardType,
	description?: string,
): void {
	const card = container.createDiv({
		cls: `crate-activity-file-card${type === 'conflict' ? ' crate-file-card-conflict' : ''}`,
	});

	card.createDiv({ cls: `crate-file-accent crate-file-accent-${type}` });
	const iconEl = card.createDiv({ cls: 'crate-file-icon' });
	setIcon(iconEl, FILE_CARD_ICONS[type]);

	const info = card.createDiv({ cls: 'crate-file-info' });
	const parts = filePath.split('/');
	const fileName = parts.pop() ?? filePath;
	const dirPath = parts.join('/');
	info.createSpan({ text: fileName, cls: 'crate-file-name', attr: { title: filePath } });
	if (description) info.createSpan({ text: description, cls: 'crate-file-path' });
	else if (dirPath) info.createSpan({ text: dirPath, cls: 'crate-file-path' });
}

export function renderEmptyState(container: HTMLElement, icon: string, title: string, description: string): void {
	const wrapper = container.createDiv({ cls: 'crate-activity-empty-state' });
	const iconEl = wrapper.createDiv({ cls: 'crate-empty-icon' });
	setIcon(iconEl, icon);
	const textEl = wrapper.createDiv({ cls: 'crate-empty-text' });
	textEl.createSpan({ text: title, cls: 'crate-empty-title' });
	textEl.createSpan({ text: description, cls: 'crate-empty-desc' });
}
