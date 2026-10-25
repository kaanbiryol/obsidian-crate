import { createModalActions, createModalFooter, SharedModal } from './plugin/shared-modal';
import { Setting, type App, type ButtonComponent } from 'obsidian';

export interface ConfirmationModalOptions {
	title: string;
	message: string;
	details?: string[];
	confirmText: string;
	cancelText?: string;
	warning?: boolean;
	checkbox?: { label: string; description?: string; onChange: (checked: boolean) => void };
	/** The confirm button stays disabled until this exact word is typed. */
	typedConfirmation?: string;
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
		const { title, message, details, confirmText, cancelText = 'Cancel', warning = false, typedConfirmation } = this.options;

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

		if (this.options.checkbox) {
			const checkbox = this.options.checkbox;
			new Setting(contentEl)
				.setClass('crate-confirmation-option')
				.setName(checkbox.label)
				.setDesc(checkbox.description ?? '')
				.addToggle(toggle => toggle.setValue(false).onChange(checkbox.onChange));
		}

		let typed = !typedConfirmation;
		let confirm: ButtonComponent | undefined;
		if (typedConfirmation) {
			new Setting(contentEl)
				.setClass('crate-confirmation-option')
				.setName('Confirm data loss')
				.setDesc(`Type ${typedConfirmation} to continue.`)
				.addText(text => text.setPlaceholder('Type confirmation').onChange(value => {
					typed = value.trim() === typedConfirmation;
					confirm?.setDisabled(!typed);
				}));
		}

		createModalActions(createModalFooter(this.contentEl))
			.addButton(button => button
				.setButtonText(cancelText)
				.onClick(() => this.finish(false)))
			.addButton(button => {
				confirm = button;
				button.setButtonText(confirmText).setDisabled(!typed);
				if (warning) {
					button.setDestructive().setCta();
				} else {
					button.setCta();
				}
				button.onClick(() => { if (typed) this.finish(true); });
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
