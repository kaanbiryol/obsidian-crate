import { Notice, type App } from 'obsidian';
import type { HistoryRestoreReview } from '../../sync/history-restore';
import { SharedModal } from '../shared/SharedModal';

export class HistoryRestoreModal extends SharedModal {
    private active = true;
    private busy = false;
    constructor(app: App, private timestamp: string, private load: () => Promise<HistoryRestoreReview>, private onRestored: () => void) { super(app); }

    onOpen(): void {
        this.openLayout('Return to this state');
        this.modalEl.addClass('crate-history-restore-modal');
        void this.render();
    }

    private async render(): Promise<void> {
        this.bodyEl.empty();
        this.bodyEl.createEl('p', { text: `Restore all synced files to the checkpoint from ${new Date(this.timestamp).toLocaleString()}. Files excluded from sync stay untouched.` });
        const status = this.bodyEl.createDiv({ text: 'Checking files and available versions…', attr: { role: 'status', 'aria-live': 'polite' } });
        try {
            const review = await this.load();
            if (!this.active) return;
            const count = (action: string) => review.items.filter(item => item.action === action).length;
            status.setText(review.items.length
                ? `${count('revert')} reverted · ${count('restore')} restored · ${count('remove')} removed`
                : 'Your synced files already match this state.');
            const list = this.bodyEl.createDiv({ cls: 'crate-discard-file-list' });
            for (const item of review.items) {
                const row = list.createDiv({ cls: 'crate-discard-file' });
                row.createSpan({ text: item.path, cls: 'crate-discard-path' });
                row.createSpan({ text: item.action === 'remove' ? 'Move to trash' : item.action === 'revert' ? 'Revert' : 'Restore', cls: 'crate-discard-action' });
            }
            if (review.unchangedCount) this.bodyEl.createEl('p', { text: `${review.unchangedCount} unchanged files will be kept.`, cls: 'crate-discard-help' });
            this.bodyEl.createEl('p', { text: 'Later edits, including unsynced edits, will be replaced. Later additions move to trash. Recovery copies are saved on this device. The restored state will sync to your other devices.', cls: 'crate-discard-help' });
            const progress = this.bodyEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
            const buttons = this.bodyEl.createDiv({ cls: 'crate-discard-buttons' });
            const cancel = buttons.createEl('button', { text: 'Cancel', cls: 'crate-activity-action', attr: { type: 'button' } });
            cancel.addEventListener('click', () => this.close());
            const confirm = buttons.createEl('button', { text: 'Return to this state', cls: 'crate-activity-action crate-activity-action-danger', attr: { type: 'button' } });
            confirm.disabled = !review.items.length;
            confirm.addEventListener('click', () => {
                this.busy = true; confirm.disabled = true; cancel.disabled = true;
                progress.setText('Saving recovery copies, restoring files, and syncing…');
                void review.restore().then(() => {
                    this.busy = false;
                    this.onRestored();
                    this.close();
                    new Notice('Synced vault returned to the selected state.');
                }).catch((error: unknown) => {
                    this.busy = false;
                    this.onRestored();
                    if (!this.active) return;
                    progress.setText(error instanceof Error ? error.message : 'Could not finish restoring this state.');
                    cancel.disabled = false;
                    this.addRetry(progress);
                });
            });
            cancel.focus();
        } catch (error) {
            if (!this.active) return;
            status.setText(error instanceof Error ? error.message : 'Could not check this checkpoint.');
            this.addRetry(status);
        }
    }

    private addRetry(container: HTMLElement): void {
        const retry = container.createEl('button', { text: 'Review again', cls: 'crate-activity-action', attr: { type: 'button' } });
        retry.addEventListener('click', () => { void this.render(); });
    }

    close(): void { if (!this.busy) super.close(); }
    onClose(): void { this.active = false; super.onClose(); }
}
