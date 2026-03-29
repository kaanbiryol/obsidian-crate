import { Modal, type App } from 'obsidian';
import qrcode from 'qrcode-generator';

export class QRModal extends Modal {
	private readonly data: string;

	constructor(app: App, data: string) {
		super(app);
		this.data = data;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('crate-qr-modal');

		contentEl.createEl('h2', { text: 'Scan to set up' });
		contentEl.createEl('p', {
			text: 'Scan this code with your other device to finish setup.',
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
			return;
		}

		wrapper.appendChild(document.importNode(parsedSvg, true));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
