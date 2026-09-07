import { Setting, type App } from 'obsidian';
import { SharedModal } from './shared/SharedModal';

export interface ConfirmationModalOptions {
	title: string;
	message: string;
	details?: string[];
	confirmText: string;
	cancelText?: string;
	warning?: boolean;
}

class ConfirmationModal extends SharedModal {
	private readonly options: ConfirmationModalOptions;
	private readonly resolve: (confirmed: boolean) => void;
	private settled = false;

	constructor(app: App, options: ConfirmationModalOptions, resolve: (confirmed: boolean) => void) {
		super(app);
		this.options = options;
		this.resolve = resolve;
	}

	onOpen(): void {
		const { modalEl } = this;
		const { title, message, details, confirmText, cancelText = 'Cancel', warning = false } = this.options;

		modalEl.addClass('crate-confirmation-modal');
		this.openLayout(title);
		const contentEl = this.bodyEl;
		contentEl.addClass('crate-confirmation-body');

		contentEl.createEl('p', {
			text: message,
			cls: 'crate-confirmation-message',
		});

		if (details?.length === 1) {
			contentEl.createEl('p', { text: details[0], cls: 'crate-confirmation-details' });
		} else if (details && details.length > 1) {
			const detailList = contentEl.createEl('ul', {
				cls: 'crate-confirmation-details',
			});
			for (const detail of details) {
				detailList.createEl('li', { text: detail });
			}
		}

		new Setting(contentEl)
			.setClass('crate-confirmation-actions')
			.addButton(button => button
				.setButtonText(cancelText)
				.onClick(() => this.finish(false)))
			.addButton(button => {
				button.setButtonText(confirmText);
				if (warning) {
					button.setDestructive();
				} else {
					button.setCta();
				}
				button.onClick(() => this.finish(true));
			});
	}

	onClose(): void {
		super.onClose();
		if (!this.settled) {
			this.resolve(false);
			this.settled = true;
		}
	}

	private finish(confirmed: boolean): void {
		if (this.settled) {
			return;
		}

		this.settled = true;
		this.resolve(confirmed);
		this.close();
	}
}

export function openConfirmationModal(app: App, options: ConfirmationModalOptions): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		new ConfirmationModal(app, options, resolve).open();
	});
}
