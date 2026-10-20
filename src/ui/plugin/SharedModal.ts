import { Modal } from 'obsidian';
import { mountModalHeader } from './mountModalHeader';

/** Shell classes for every Crate dialog, whether its body is Obsidian DOM or a React layout. */
export function applySharedModalShell(modal: Modal): void {
	modal.modalEl.addClass('crate-shared-modal', 'crate-custom-modal-close');
	modal.contentEl.addClass('crate-reminders-ui');
}

/** Obsidian owns focus and dismissal; Crate owns the shared header and body. */
export abstract class SharedModal extends Modal {
	protected bodyEl!: HTMLDivElement;
	private unmountHeader?: ReturnType<typeof mountModalHeader>;

	protected openLayout(title: string): void {
		applySharedModalShell(this);
		this.setTitle(title);
		const header = this.contentEl.createDiv({ cls: 'crate-modal-header-host' });
		this.unmountHeader = mountModalHeader(header, title, () => this.close());
		this.bodyEl = this.contentEl.createDiv({ cls: 'crate-modal-body' });
	}
	protected setLayoutTitle(title: string): void {
		this.setTitle(title);
		this.unmountHeader?.setTitle(title);
	}

	onClose(): void {
		this.unmountHeader?.();
		this.unmountHeader = undefined;
		this.contentEl.empty();
	}
}
