import { Modal, Setting } from 'obsidian';
import { mountModalHeader } from './mountModalHeader';

export function hideNativeModalCloseButton(modalEl: HTMLElement): void {
	// Scope native close-control styles to modal shells with a Crate replacement.
	modalEl.addClass('crate-custom-modal-close');
}

/** Shell classes for every Crate dialog, whether its body is Obsidian DOM or a React layout. */
export function applySharedModalShell(modal: Modal): void {
	modal.modalEl.addClass('crate-shared-modal');
	hideNativeModalCloseButton(modal.modalEl);
	modal.contentEl.addClass('crate-reminders-ui');
}

/** Native counterparts of ModalLayout's footer and action group. */
export function createModalFooter(container: HTMLElement): HTMLDivElement {
	return container.createDiv({ cls: 'crate-modal-footer' });
}

export function createModalActions(container: HTMLElement): Setting {
	return new Setting(container).setClass('crate-modal-actions');
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
