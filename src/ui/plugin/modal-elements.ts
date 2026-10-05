import { Setting } from 'obsidian';

/** Native counterparts of ModalLayout's footer and action group. */
export function createModalFooter(container: HTMLElement): HTMLDivElement {
	return container.createDiv({ cls: 'crate-modal-footer' });
}

export function createModalActions(container: HTMLElement): Setting {
	return new Setting(container).setClass('crate-modal-actions');
}
