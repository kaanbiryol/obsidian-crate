import { Modal, Setting, type App } from 'obsidian';

export interface ConfirmationModalOptions {
	title: string;
	message: string;
	details?: string[];
	confirmText: string;
	cancelText?: string;
	warning?: boolean;
}

class ConfirmationModal extends Modal {
	private readonly options: ConfirmationModalOptions;
	private readonly resolve: (confirmed: boolean) => void;
	private settled = false;

	constructor(app: App, options: ConfirmationModalOptions, resolve: (confirmed: boolean) => void) {
		super(app);
		this.options = options;
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		const { title, message, details, confirmText, cancelText = 'Cancel', warning = false } = this.options;

		modalEl.addClass('crate-confirmation-modal');
		contentEl.addClass('crate-confirmation-body');
		this.setTitle(title);

		contentEl.createEl('p', {
			text: message,
			cls: 'crate-confirmation-message',
		});

		if (details && details.length > 0) {
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
					button.setWarning();
				} else {
					button.setCta();
				}
				button.onClick(() => this.finish(true));
			});
	}

	onClose(): void {
		this.contentEl.empty();
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
