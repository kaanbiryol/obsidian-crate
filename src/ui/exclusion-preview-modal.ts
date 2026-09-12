import { Modal, Setting, type App } from 'obsidian';

export class ExclusionPreviewModal extends Modal {
	constructor(app: App, private readonly paths: readonly string[]) { super(app); }

	onOpen(): void {
		this.setTitle('Excluded files');
		this.modalEl.addClass('crate-exclusion-preview-modal');
		this.contentEl.createEl('p', {
			text: 'Files matching the exclusion patterns in settings, including hidden files. This preview does not change local or server files.',
			cls: 'setting-item-description',
		});
		const searchSetting = new Setting(this.contentEl).setName('Search files');
		const count = this.contentEl.createEl('p', { cls: 'setting-item-description' });
		count.setAttribute('role', 'status');
		const list = this.contentEl.createEl('ul', { cls: 'crate-exclusion-preview-list' });
		list.setAttribute('aria-label', 'Matching excluded files');
		list.setAttribute('tabindex', '0');
		const render = (query: string) => {
			const needle = query.trim().toLocaleLowerCase();
			const matches = needle ? this.paths.filter(path => path.toLocaleLowerCase().includes(needle)) : this.paths;
			count.setText(needle ? `${matches.length} of ${this.paths.length} files` : `${matches.length} matching files`);
			list.empty();
			if (!matches.length) {
				count.setText(needle ? 'No files match your search.' : 'No files match these exclusion patterns.');
			}
			for (const path of matches) list.createEl('li', { text: path });
		};
		searchSetting.addText(text => {
			text.setPlaceholder('Filter by file or folder').onChange(render);
			text.inputEl.type = 'search';
			text.inputEl.setAttribute('aria-label', 'Search excluded files');
		});
		render('');
	}

	onClose(): void { this.contentEl.empty(); }
}
