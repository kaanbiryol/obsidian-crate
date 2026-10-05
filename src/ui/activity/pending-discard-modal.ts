import { Notice, type App } from 'obsidian';
import type { PendingDiscardReview } from '../../sync/pending-discard';
import { createModalFooter } from '../plugin/modal-elements';
import { SharedModal } from '../plugin/SharedModal';

export class PendingDiscardModal extends SharedModal {
    private active = true;
    private footer!: HTMLDivElement;
    constructor(app: App, private load: () => Promise<PendingDiscardReview>, private onDiscarded: () => void, private paths: string[]) { super(app); }
    onOpen(): void {
        this.openLayout('Discard changes?');
        this.modalEl.addClass('crate-pending-discard-modal');
        this.footer = createModalFooter(this.contentEl);
        void this.render();
    }
    private async render(): Promise<void> {
        this.bodyEl.empty();
        this.footer.empty();
        this.bodyEl.createEl('p', { text: 'Restore the last-synced versions. New local files move to trash.' });
        const list = this.bodyEl.createDiv({ cls: 'crate-discard-file-list', attr: { 'aria-busy': 'true' } });
        for (const path of this.paths) {
            const row = list.createDiv({ cls: 'crate-discard-file' });
            row.createSpan({ text: path, cls: 'crate-discard-path' });
            row.createSpan({ text: 'Checking…', cls: 'crate-discard-action' });
        }
        this.bodyEl.createEl('p', { text: 'Recovery copies of replaced files are saved on this device.', cls: 'crate-discard-help' });
        this.bodyEl.createDiv({ text: 'Checking selected files…', attr: { role: 'status' } });
        const buttons = this.footer.createDiv({ cls: 'crate-modal-actions' });
        const cancel = buttons.createEl('button', { text: 'Cancel', cls: 'crate-action-button', attr: { type: 'button' } });
        cancel.addEventListener('click', () => this.close());
        const confirm = buttons.createEl('button', { text: 'Discard changes', cls: 'mod-warning', attr: { type: 'button' } });
        confirm.disabled = true;
        try {
            const review = await this.load();
            if (!this.active) return;
            this.bodyEl.empty();
            this.footer.empty();
            this.bodyEl.createEl('p', { text: 'Restore the last-synced versions. New local files move to trash.' });
            const list = this.bodyEl.createDiv({ cls: 'crate-discard-file-list' });
            for (const item of review.items) {
                const row = list.createDiv({ cls: 'crate-discard-file' });
                row.createSpan({ text: item.path, cls: 'crate-discard-path' });
                row.createSpan({ text: item.action === 'restore' ? 'Restore' : 'Move to trash', cls: 'crate-discard-action' });
            }
            if (review.unchangedCount) this.bodyEl.createEl('p', { text: `${review.unchangedCount} unchanged files will be kept.`, cls: 'crate-discard-help' });
            if (!review.items.length) this.bodyEl.createEl('p', { text: 'No changes to discard.' });
            else this.bodyEl.createEl('p', { text: 'Recovery copies of replaced files are saved on this device.', cls: 'crate-discard-help' });
            const status = this.bodyEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
            const buttons = this.footer.createDiv({ cls: 'crate-modal-actions' });
            const cancel = buttons.createEl('button', { text: 'Cancel', cls: 'crate-action-button', attr: { type: 'button' } });
            cancel.addEventListener('click', () => this.close());
            const confirm = buttons.createEl('button', { text: `Discard changes (${review.items.length})`, cls: 'mod-warning', attr: { type: 'button' } });
            confirm.disabled = review.items.length === 0;
            confirm.addEventListener('click', () => {
                confirm.disabled = true; cancel.disabled = true;
                status.textContent = 'Discarding changes…';
                void review.discard().then(() => {
                    this.onDiscarded();
                    if (this.active) this.close();
                    new Notice('Changes discarded.');
                }).catch((error: unknown) => {
                    this.onDiscarded();
                    if (!this.active) return;
                    status.textContent = error instanceof Error ? error.message : 'Could not discard changes.';
                    this.addRetry(status); cancel.disabled = false;
                });
            });
            cancel.focus();
        } catch (error) {
            if (!this.active) return;
            this.footer.empty();
            this.bodyEl.setText(error instanceof Error ? error.message : 'Could not check the selected files.');
            this.addRetry(this.footer.createDiv({ cls: 'crate-modal-actions' }));
        }
    }
    private addRetry(container: HTMLElement): void {
        const retry = container.createEl('button', { text: 'Review again', cls: 'crate-action-button', attr: { type: 'button' } });
        retry.addEventListener('click', () => { void this.render(); });
    }
    onClose(): void { this.active = false; super.onClose(); }
}
