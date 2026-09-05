import { setIcon } from 'obsidian';

export type FileCardType = 'upload' | 'download' | 'merge' | 'delete' | 'conflict';
export type EmptyStateTone = 'accent' | 'success';

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

	const iconEl = card.createDiv({ cls: `crate-file-icon crate-file-icon-${type}` });
	setIcon(iconEl, FILE_CARD_ICONS[type]);
    iconEl.setAttribute('aria-label', type === 'merge' ? 'Merged' : type === 'conflict' ? 'Conflict' : type === 'delete' ? 'Delete' : type === 'upload' ? 'Upload' : 'Download');
    iconEl.setAttribute('role', 'img');

	const info = card.createDiv({ cls: 'crate-file-info' });
	const parts = filePath.split('/');
	const fileName = parts.pop() ?? filePath;
	const dirPath = parts.join('/');
	info.createSpan({ text: fileName, cls: 'crate-file-name', attr: { title: filePath } });
	if (description) info.createSpan({ text: description, cls: 'crate-file-path' });
	else if (dirPath) info.createSpan({ text: dirPath, cls: 'crate-file-path' });
}

export function renderEmptyState(
	container: HTMLElement,
	icon: string,
	title: string,
	description: string,
	tone: EmptyStateTone = 'accent',
): void {
	const wrapper = container.createDiv({ cls: 'crate-activity-empty-state' });
	const iconEl = wrapper.createDiv({ cls: `crate-empty-icon crate-empty-icon-${tone}` });
	setIcon(iconEl, icon);
	const textEl = wrapper.createDiv({ cls: 'crate-empty-text' });
	textEl.createSpan({ text: title, cls: 'crate-empty-title' });
	textEl.createSpan({ text: description, cls: 'crate-empty-desc' });
}
