import { Notice, type App } from 'obsidian';
import type { PendingDiscardReview } from '../../sync/pending-discard';
import { SharedModal } from '../shared/SharedModal';

export class PendingDiscardModal extends SharedModal {
    private active = true;
    constructor(app: App, private load: () => Promise<PendingDiscardReview>, private onDiscarded: () => void) { super(app); }
    onOpen(): void {
        this.openLayout('Discard changes?');
        this.modalEl.addClass('crate-pending-discard-modal');
        void this.render();
    }
    private async render(): Promise<void> {
        this.bodyEl.setText('Checking selected files…');
        try {
            const review = await this.load();
            if (!this.active) return;
            this.bodyEl.empty();
            this.bodyEl.createEl('p', { text: 'Restore the server versions of these files. Files added only on this device move to trash.' });
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
            const buttons = this.bodyEl.createDiv({ cls: 'crate-discard-buttons' });
            const cancel = buttons.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
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
            this.bodyEl.setText(error instanceof Error ? error.message : 'Could not check the selected files.');
            this.addRetry(this.bodyEl);
        }
    }
    private addRetry(container: HTMLElement): void {
        const retry = container.createEl('button', { text: 'Review again', attr: { type: 'button' } });
        retry.addEventListener('click', () => { void this.render(); });
    }
    onClose(): void { this.active = false; super.onClose(); }
}
