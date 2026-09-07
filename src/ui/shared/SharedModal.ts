import { Modal } from 'obsidian';
import { mountModalHeader } from './mountModalHeader';

/** Obsidian owns focus and dismissal; Crate owns the shared header and body. */
export abstract class SharedModal extends Modal {
	protected bodyEl!: HTMLDivElement;
	private unmountHeader?: () => void;

	protected openLayout(title: string): void {
		this.modalEl.addClass('crate-shared-modal', 'crate-custom-modal-close');
		this.contentEl.addClass('crate-reminders-ui');
		this.setTitle(title);
		const header = this.contentEl.createDiv({ cls: 'crate-modal-header-host' });
		this.unmountHeader = mountModalHeader(header, title, () => this.close());
		this.bodyEl = this.contentEl.createDiv({ cls: 'crate-modal-body' });
	}

	onClose(): void {
		this.unmountHeader?.();
		this.unmountHeader = undefined;
		this.contentEl.empty();
	}
}
