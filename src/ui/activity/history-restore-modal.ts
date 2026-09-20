import { Notice, Setting, type App } from 'obsidian';
import type { HistoryRestoreReview } from '../../sync/history-restore';
import { SharedModal } from '../shared/SharedModal';
import type { SyncHistoryEntry } from '../../sync/types';
import { historyPointLabel } from './history-point';

/** Confirm once, then apply the verified restore; diffs live in Vault history. */
export class HistoryRestoreModal extends SharedModal {
    private active = true;
    private busy = false;
    private review?: HistoryRestoreReview;
    private status!: HTMLElement;
    private confirm!: HTMLButtonElement;
    private cancel!: HTMLButtonElement;
    constructor(app: App, private entry: SyncHistoryEntry, private load: () => Promise<HistoryRestoreReview>, private onRestored: () => void) { super(app); }

    onOpen(): void {
        this.openLayout('Restore vault?');
        this.modalEl.addClass('crate-confirmation-modal', 'crate-history-restore-modal');
        this.bodyEl.addClass('crate-confirmation-body');
        this.bodyEl.createEl('p', {
            text: `${historyPointLabel(this.entry)} · ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(this.entry.timestamp))}`,
            cls: 'crate-confirmation-message',
        });
        this.bodyEl.createEl('p', {
            text: 'Later edits, including unsynced edits, will be replaced. Later additions move to trash. Files excluded from sync stay untouched.',
            cls: 'crate-confirmation-details',
        });
        this.bodyEl.createEl('p', {
            text: 'Recovery copies are saved on this device. The restored state will sync to your other devices.',
            cls: 'crate-confirmation-details',
        });
        this.status = this.bodyEl.createEl('p', { cls: 'crate-confirmation-details', attr: { role: 'status', 'aria-live': 'polite' } });
        new Setting(this.bodyEl).setClass('crate-confirmation-actions')
            .addButton(button => {
                this.cancel = button.buttonEl;
                button.setButtonText('Cancel').onClick(() => this.close());
            })
            .addButton(button => {
                this.confirm = button.buttonEl;
                button.setButtonText('Restore').setDestructive().onClick(() => {
                    if (this.busy || this.confirm.disabled) return;
                    if (this.review) void this.restore(this.review);
                    else void this.prepare();
                });
            });
        void this.prepare();
    }

    private async prepare(): Promise<void> {
        this.review = undefined;
        this.confirm.disabled = true;
        this.confirm.setText('Restore');
        this.status.setText('Checking files and available versions…');
        try {
            const review = await this.load();
            if (!this.active) return;
            this.review = review;
            this.status.setText(review.items.length
                ? `${review.items.length} ${review.items.length === 1 ? 'file' : 'files'} will change · ${review.unchangedCount} unchanged`
                : 'Your synced files already match this state.');
            this.confirm.disabled = !review.items.length;
        } catch (error) {
            if (this.active) this.showError(error, 'Could not check this restore point.');
        }
    }

    private async restore(review: HistoryRestoreReview): Promise<void> {
        this.busy = true;
        this.confirm.disabled = true;
        this.cancel.disabled = true;
        const close = this.contentEl.querySelector<HTMLButtonElement>('.reminder-modal-header-close');
        if (close) close.disabled = true;
        this.status.setText('Saving recovery copies, restoring files, and syncing…');
        try {
            await review.restore();
            this.busy = false;
            this.onRestored();
            this.close();
            new Notice('Synced vault returned to the selected state.');
        } catch (error) {
            this.onRestored();
            if (this.active) this.showError(error, 'Could not finish restoring this state.');
        } finally {
            this.busy = false;
            this.cancel.disabled = false;
            if (close) close.disabled = false;
        }
    }

    private showError(error: unknown, fallback: string): void {
        this.review = undefined;
        this.status.setText(error instanceof Error ? error.message : fallback);
        this.confirm.setText('Try again');
        this.confirm.disabled = false;
    }

    close(): void { if (!this.busy) super.close(); }
    onClose(): void { this.active = false; super.onClose(); }
}
