import type { App } from 'obsidian';
import { SharedModal } from './shared/SharedModal';

interface ExternalBrowserLinkOptions {
	title: string;
	message: string;
	linkText: string;
	showCopyableUrl?: boolean;
}

class ExternalBrowserModal extends SharedModal {
	constructor(app: App, private readonly url: string, private readonly options: ExternalBrowserLinkOptions) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('crate-external-browser-modal');
		this.openLayout(this.options.title);
		this.bodyEl.createEl('p', { text: this.options.message });
		const link = this.bodyEl.createEl('a', {
			text: this.options.linkText,
			cls: 'external-link crate-external-browser-link',
		});
		link.setAttribute('href', this.url);
		link.setAttribute('target', '_blank');
		link.setAttribute('rel', 'noopener noreferrer');
		if (this.options.showCopyableUrl) {
			const field = this.bodyEl.createEl('textarea', { cls: 'crate-external-browser-url' });
			field.value = this.url;
			field.readOnly = true;
			field.setAttribute('aria-label', 'Setup link');
			field.addEventListener('focus', () => field.select());
		}
	}
}

export function openExternalBrowserModal(app: App, url: string, options: ExternalBrowserLinkOptions): void {
	new ExternalBrowserModal(app, url, options).open();
}
