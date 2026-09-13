import { Modal, Platform, Setting, type App } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ExclusionSheet } from './ExclusionSheet';
import { hideNativeModalCloseButton } from '../reminders/ui/adapters/modalShell';

export class ExclusionPreviewModal extends Modal {
	hasInitialInputFocus = false;
	private root?: Root;
	constructor(app: App, private readonly paths: readonly string[]) { super(app); }

	onOpen(): void {
		this.modalEl.addClass('crate-reminder-editor-modal');
		this.modalEl.toggleClass('is-mobile', Platform.isMobile);
		hideNativeModalCloseButton(this.modalEl);
		this.contentEl.addClasses(['crate-reminder-editor-modal__content', 'crate-reminders-ui']);
		this.root = createRoot(this.contentEl);
		this.root.render(createElement(ExclusionSheet, {
			animationsEnabled: typeof window !== 'undefined' && this.contentEl.win === window,
			onClose: () => this.close(),
			onMount: container => this.renderPreview(container),
		}));
	}

	private renderPreview(container: HTMLDivElement): void {
		container.createEl('p', {
			text: 'Files excluded from sync, including hidden files. Preview only.',
			cls: 'crate-exclusion-description',
		});
		const searchSetting = new Setting(container).setName('Search files');
		searchSetting.settingEl.addClass('crate-exclusion-search');
		const count = container.createEl('p', { cls: 'crate-exclusion-count' });
		count.setAttribute('role', 'status');
		const list = container.createEl('ul', { cls: 'crate-exclusion-preview-list' });
		list.setAttribute('aria-label', 'Matching excluded files');
		list.setAttribute('tabindex', '0');
		// Keep the DOM bounded even for vaults with tens of thousands of matches.
		const rowHeight = 58;
		const windowSize = 40;
		const searchablePaths = this.paths.map(path => path.toLocaleLowerCase());
		let matches: readonly string[] = this.paths;
		let renderedStart = -1;
		const renderWindow = () => {
			const start = Math.max(0, Math.min(matches.length - windowSize, Math.floor(list.scrollTop / rowHeight) - 8));
			if (start === renderedStart) return;
			renderedStart = start;
			list.empty();
			const spacer = (height: number) => {
				const element = list.createEl('li', { cls: 'crate-exclusion-spacer' });
				element.setAttribute('aria-hidden', 'true');
				element.style.setProperty('height', `${height}px`);
			};
			spacer(start * rowHeight);
			const end = Math.min(matches.length, start + windowSize);
			for (let index = start; index < end; index++) {
				const path = matches[index]!;
				const row = list.createEl('li', { attr: { title: path } });
				row.setAttribute('aria-posinset', String(index + 1));
				row.setAttribute('aria-setsize', String(matches.length));
				const slash = path.lastIndexOf('/');
				row.createSpan({ text: path.slice(slash + 1), cls: 'crate-exclusion-name' });
				if (slash >= 0) row.createSpan({ text: path.slice(0, slash + 1), cls: 'crate-exclusion-folder' });
			}
			spacer((matches.length - end) * rowHeight);
		};
		list.addEventListener('scroll', renderWindow, { passive: true });
		const render = (query: string) => {
			const needle = query.trim().toLocaleLowerCase();
			matches = needle ? this.paths.filter((_, index) => searchablePaths[index]!.includes(needle)) : this.paths;
			count.setText(needle ? `${matches.length} of ${this.paths.length} files` : `${matches.length} matching files`);
			if (!matches.length) count.setText(needle ? 'No files match your search.' : 'No files match these exclusion patterns.');
			list.scrollTop = 0;
			renderedStart = -1;
			renderWindow();
		};
		searchSetting.addText(text => {
			text.setPlaceholder('Filter by file or folder').onChange(render);
			text.inputEl.type = 'search';
			text.inputEl.setAttribute('aria-label', 'Search excluded files');
		});
		render('');
	}

	onClose(): void {
		this.root?.unmount();
		this.root = undefined;
		this.contentEl.empty();
		this.contentEl.removeClass('crate-reminder-editor-modal__content', 'crate-reminders-ui');
	}
}
