import { Notice, Setting, type App } from 'obsidian';
import { SharedModal } from './shared/SharedModal';
import qrcode from 'qrcode-generator';

export class QRModal extends SharedModal {
	private readonly data: string;

	constructor(app: App, data: string) {
		super(app);
		this.data = data;
	}

	onOpen(): void {
		this.openLayout('Connect another device');
		const contentEl = this.bodyEl;
		this.modalEl.addClass('crate-qr-modal');

		const fragment = new URLSearchParams(this.data.split('#')[1]);
		const hasRecovery = fragment.has('crateKey') || fragment.has('crateReadingKey');
		contentEl.createEl('p', {
			text: hasRecovery
				? 'Scan with a trusted device, or copy the link. Sign-in expires in 10 minutes. The link also contains your recovery key, which does not expire. Keep it private.'
				: 'Scan this code with your other device, or copy the link below. This setup link expires in 10 minutes.',
			cls: 'crate-qr-desc',
		});

		const qr = qrcode(0, 'L');
		qr.addData(this.data);
		qr.make();

		const wrapper = contentEl.createDiv({ cls: 'crate-qr-wrapper' });
		const parsedSvg = new DOMParser().parseFromString(
			qr.createSvgTag({ scalable: true }),
			'image/svg+xml',
		).documentElement;

		if (parsedSvg.tagName.toLowerCase() !== 'svg') {
			wrapper.setText('Unable to render setup code.');
		} else {
			wrapper.appendChild(document.importNode(parsedSvg, true));
		}

		const fallback = contentEl.createDiv({ cls: 'crate-qr-link-fallback' });
		fallback.hide();
		new Setting(contentEl).setClass('crate-qr-actions')
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

	onClose(): void {
		super.onClose();
	}
}
