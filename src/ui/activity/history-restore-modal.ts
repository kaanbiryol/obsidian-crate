import { Notice, Platform, setIcon, type App } from 'obsidian';
import type { HistoryRestoreReview } from '../../sync/history-restore';
import { SharedModal } from '../shared/SharedModal';
import { openConfirmationModal } from '../confirmation-modal';
import type { SyncHistoryEntry } from '../../sync/types';
import { historyPointLabel } from './history-point';
import { buildDiff } from './diff-model';
import { renderDiffLines } from './diff-renderer';
import { renderFileText } from './history-text';

export class HistoryRestoreModal extends SharedModal {
    private active = true;
    private busy = false;
    private previewGeneration = 0;
    private workspace!: HTMLElement;
    private list!: HTMLElement;
    private preview!: HTMLElement;
    constructor(app: App, private entry: SyncHistoryEntry, private load: () => Promise<HistoryRestoreReview>, private onRestored: () => void) { super(app); }

    onOpen(): void {
        this.openLayout('Review restore point');
        this.modalEl.addClass('crate-file-history-modal', 'crate-history-restore-modal');
        this.modalEl.toggleClass('is-mobile', Platform.isMobile);
        this.bodyEl.addClass('crate-file-history', 'crate-state-review');
        void this.render();
    }

    private pointDescription(): string {
        return `${historyPointLabel(this.entry)} · ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(this.entry.timestamp))}`;
    }

    private async render(): Promise<void> {
        this.previewGeneration++;
        this.bodyEl.empty();
        const context = this.bodyEl.createDiv({ cls: 'crate-state-review-context' });
        context.createEl('p', { text: this.pointDescription(), cls: 'crate-history-description' });
        const status = this.bodyEl.createDiv({ text: 'Checking files and available versions…', cls: 'crate-browser-empty', attr: { role: 'status', 'aria-live': 'polite' } });
        try {
            const review = await this.load();
            if (!this.active) return;
            status.remove();
            context.createSpan({ text: `${review.items.length} ${review.items.length === 1 ? 'change' : 'changes'} · ${review.unchangedCount} unchanged`, cls: 'crate-history-file-count' });
            this.workspace = this.bodyEl.createDiv({ cls: 'crate-history-workspace' });
            this.workspace.setAttribute('data-pane', 'list');
            this.list = this.workspace.createEl('nav', { cls: 'crate-history-list-pane', attr: { 'aria-label': 'Files to restore' } });
            this.list.createEl('h4', { text: 'Files', cls: 'crate-history-group' });
            this.preview = this.workspace.createDiv({ cls: 'crate-history-preview-pane' });
            const fileButtons: HTMLButtonElement[] = [];
            for (const item of review.items) {
                const select = this.list.createEl('button', { cls: 'crate-history-version', attr: { type: 'button', 'aria-label': `Preview changes to ${item.path}`, 'aria-current': 'false' } });
                select.createSpan({ text: item.path.split('/').pop()!, cls: 'crate-history-file-name' });
                const folder = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
                const action = item.action === 'remove' ? 'Move to trash' : item.action === 'revert' ? 'Revert' : 'Restore';
                select.createSpan({ text: [folder, action].filter(Boolean).join(' · '), cls: 'crate-history-file-folder' });
                fileButtons.push(select);
                select.addEventListener('click', () => {
                    if (this.busy) return;
                    for (const button of fileButtons) button.setAttribute('aria-current', String(button === select));
                    this.workspace.setAttribute('data-pane', 'preview');
                    void this.showPreview(review, item.path, true);
                });
            }
            if (review.items[0]) {
                fileButtons[0]!.setAttribute('aria-current', 'true');
                void this.showPreview(review, review.items[0].path);
            } else {
                this.workspace.setAttribute('data-pane', 'preview');
                this.preview.createEl('p', { text: 'Your synced files already match this state.', cls: 'crate-history-description' });
            }
            const progress = this.bodyEl.createDiv({ cls: 'crate-state-review-status', attr: { role: 'status', 'aria-live': 'polite' } });
            const footer = this.bodyEl.createDiv({ cls: 'crate-state-review-footer' });
            footer.createSpan({ text: 'All synced files · Exclusions kept', cls: 'crate-history-hint' });
            const buttons = footer.createDiv({ cls: 'crate-state-review-actions' });
            const cancel = buttons.createEl('button', { text: 'Cancel', cls: 'crate-activity-action', attr: { type: 'button' } });
            cancel.addEventListener('click', () => this.close());
            const confirm = buttons.createEl('button', { text: 'Restore…', cls: 'crate-activity-action', attr: { type: 'button' } });
            confirm.disabled = !review.items.length;
            confirm.addEventListener('click', () => {
                if (this.busy) return;
                this.busy = true;
                for (const button of [...fileButtons, confirm, cancel]) button.disabled = true;
                void this.confirmRestore(review, progress).then(result => {
                    if (!this.active) return;
                    cancel.disabled = false;
                    if (result === 'cancelled') {
                        for (const button of [...fileButtons, confirm]) button.disabled = false;
                        confirm.focus();
                    }
                });
            });
            const title = this.contentEl.querySelector<HTMLElement>('.reminder-modal-header-title');
            if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
        } catch (error) {
            if (!this.active) return;
            status.setText(error instanceof Error ? error.message : 'Could not check this checkpoint.');
            this.addRetry(status);
        }
    }

    private async confirmRestore(review: HistoryRestoreReview, progress: HTMLElement): Promise<'cancelled' | 'finished'> {
        try {
            const confirmed = await openConfirmationModal(this.app, {
                title: 'Return to this state?',
                message: this.pointDescription(),
                details: [
                    'Later edits, including unsynced edits, will be replaced. Later additions move to trash. Files excluded from sync stay untouched.',
                    'Recovery copies are saved on this device. The restored state will sync to your other devices.',
                ],
                confirmText: 'Return to this state', warning: true,
            });
            if (!confirmed || !this.active) return 'cancelled';
            this.previewGeneration++;
            progress.setText('Saving recovery copies, restoring files, and syncing…');
            await review.restore();
            this.busy = false;
            this.onRestored();
            this.close();
            new Notice('Synced vault returned to the selected state.');
        } catch (error) {
            this.onRestored();
            if (this.active) {
                progress.setText(error instanceof Error ? error.message : 'Could not finish restoring this state.');
                this.addRetry(progress);
            }
        } finally { this.busy = false; }
        return 'finished';
    }

    private async showPreview(review: HistoryRestoreReview, path: string, focus = false): Promise<void> {
        const generation = ++this.previewGeneration;
        this.preview.empty();
        const back = this.preview.createEl('button', { cls: 'crate-history-back', attr: { type: 'button', 'aria-label': 'Back to files' } });
        setIcon(back.createSpan({ attr: { 'aria-hidden': 'true' } }), 'arrow-left');
        back.createSpan({ text: 'Files' });
        back.addEventListener('click', () => {
            this.workspace.setAttribute('data-pane', 'list');
            this.list.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
        });
        const header = this.preview.createDiv({ cls: 'crate-history-preview-header' });
        const title = header.createEl('h3', { text: path, attr: { tabindex: '-1' } });
        if (focus) title.focus({ preventScroll: true });
        const comparison = header.createDiv({ cls: 'crate-history-comparison' });
        comparison.createSpan({ text: 'Current → Restore point' });
        const counts = comparison.createSpan({ cls: 'crate-history-diff-summary' });
        const output = this.preview.createDiv({ cls: 'crate-history-preview-output crate-history-diff crate-file-diff' });
        const status = output.createEl('p', { text: 'Loading changes…', cls: 'crate-history-description', attr: { role: 'status', 'aria-live': 'polite' } });
        try {
            const preview = await review.preview(path);
            if (!this.active || generation !== this.previewGeneration) return;
            if ('unavailable' in preview) { status.setText(preview.unavailable); return; }
            const diff = buildDiff(preview.current, preview.saved);
            if (diff.limited) { status.setText('This change is too large to display. You can still restore this point.'); return; }
            if (!diff.added && !diff.removed) { status.setText('No local content changes. Restoring will also reconcile the server copy.'); return; }
            status.remove();
            counts.createSpan({ text: `+${diff.added}`, cls: 'is-added', attr: { 'aria-label': `${diff.added} added lines` } });
            counts.createSpan({ text: `−${diff.removed}`, cls: 'is-removed', attr: { 'aria-label': `${diff.removed} removed lines` } });
            renderDiffLines(output, diff.lines, `Changes from current file to restore point: ${path}`, (container, line) => renderFileText(container, line.text || ' ', line.words));
        } catch (error) {
            if (!this.active || generation !== this.previewGeneration) return;
            status.setText(error instanceof Error ? error.message : 'Could not load this file preview.');
            const retry = output.createEl('button', { text: 'Retry preview', cls: 'crate-activity-action', attr: { type: 'button' } });
            retry.addEventListener('click', () => { if (!this.busy) void this.showPreview(review, path); });
        }
    }

    private addRetry(container: HTMLElement): void {
        const retry = container.createEl('button', { text: 'Review again', cls: 'crate-activity-action', attr: { type: 'button' } });
        retry.addEventListener('click', () => { void this.render(); });
    }

    close(): void { if (!this.busy) super.close(); }
    onClose(): void { this.active = false; this.previewGeneration++; super.onClose(); }
}
