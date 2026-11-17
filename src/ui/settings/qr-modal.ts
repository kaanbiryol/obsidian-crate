import { createModalActions, createModalFooter, SharedModal } from '../plugin/shared-modal';
import { Notice, Platform, Setting, type App } from 'obsidian';
import qrcode from 'qrcode-generator';

export class QRModal extends SharedModal {
	private readonly data: string;
	private readonly title: string;

	constructor(app: App, data: string, title: string) {
		super(app);
		this.data = data;
		this.title = title;
	}

	onOpen(): void {
		this.openLayout(this.title);
		const contentEl = this.bodyEl;
		this.modalEl.addClass('crate-qr-modal');

		contentEl.createEl('p', {
			text: `Scan this code with your ${Platform.isMobile ? 'other device' : 'phone'}, or copy the link below. This setup link expires in 10 minutes.`,
			cls: 'crate-qr-desc',
		});

		renderQrCode(contentEl.createDiv({ cls: 'crate-qr-wrapper' }), this.data);

		const fallback = contentEl.createDiv({ cls: 'crate-qr-link-fallback' });
		fallback.hide();
		createModalActions(createModalFooter(this.contentEl))
			.addButton(button => button.setButtonText('Copy link').onClick(async () => {
				try {
					await navigator.clipboard.writeText(this.data);
					new Notice('Setup link copied');
				} catch {
					fallback.empty();
					fallback.show();
					new Setting(fallback).setName('Copy this link').addTextArea(text => {
						text.setValue(this.data);
						text.inputEl.readOnly = true;
						text.inputEl.setAttribute('aria-label', 'Setup link');
						text.inputEl.focus();
					});
				}
			}));
	}
}

export function renderQrCode(wrapper: HTMLElement, data: string): void {
	const qr = qrcode(0, 'L');
	qr.addData(data);
	qr.make();
	const parsedSvg = new DOMParser().parseFromString(
		qr.createSvgTag({ scalable: true }),
		'image/svg+xml',
	).documentElement;

	if (parsedSvg.tagName.toLowerCase() !== 'svg') {
		wrapper.setText('Unable to render setup code.');
	} else {
		wrapper.appendChild(document.importNode(parsedSvg, true));
	}
}
