import { Notice, Platform, setIcon, type App } from 'obsidian';
import type { ConflictRecord } from '../../sync/types';
import type { ConflictChoice, ConflictReview } from '../../sync/conflict-review';
import { buildConflictDiff, renderConflictDiffLine } from './conflict-diff';
import { getPendingFileActions } from './file-actions';
import { SharedModal } from '../shared/SharedModal';

export class ConflictReviewModal extends SharedModal {
    private active = true;
    private busy = false;
    private revision = 0;
    private draft: string | undefined;
    private selected: ConflictChoice | undefined;
    private awaitingExternal = false;
    private readonly returnToReview = () => {
        if (this.awaitingExternal && !this.busy) {
            this.awaitingExternal = false;
            void this.refresh(true);
        }
    };
    constructor(app: App, private record: ConflictRecord, private load: () => Promise<ConflictReview>, private resolved: () => void) { super(app); }
    onOpen(): void {
        this.openLayout('Review conflict');
        this.modalEl.addClass('crate-conflict-review-modal');
        this.modalEl.toggleClass('is-mobile', Platform.isMobile);
        this.contentEl.win.addEventListener('focus', this.returnToReview);
        void this.refresh();
    }
    private async refresh(returning = false): Promise<void> {
        if (this.busy) return;
        const revision = ++this.revision;
        this.contentEl.querySelector('.crate-conflict-actions')?.remove();
        this.bodyEl.setText('Loading both versions…');
        try {
            const review = await this.load();
            if (this.active && revision === this.revision) this.render(review, returning);
        } catch (error) {
            if (this.active && revision === this.revision) {
                this.bodyEl.empty();
                const errorState = this.bodyEl.createDiv({ cls: 'crate-conflict-load-error', attr: { role: 'alert' } });
                errorState.createEl('h3', { text: 'Could not load both versions' });
                errorState.createEl('p', { text: error instanceof Error ? error.message : String(error), cls: 'crate-conflict-review-help' });
                this.addReloadButton(errorState);
            }
        }
    }
    private addReloadButton(parent: HTMLElement): void {
        const reload = parent.createEl('button', { text: 'Reload versions', cls: 'crate-conflict-action', attr: { type: 'button' } });
        reload.addEventListener('click', () => { void this.refresh(true); });
    }
    private render(review: ConflictReview, returning: boolean): void {
        const body = this.bodyEl;
        body.empty();
        const intro = body.createDiv({ cls: 'crate-conflict-intro' });
        const fileInfo = intro.createDiv({ cls: 'crate-conflict-file-heading' });
        const parts = this.record.originalPath.split('/');
        fileInfo.createEl('h3', { text: parts.pop()!, cls: 'crate-conflict-review-path' });
        fileInfo.createSpan({ text: parts.join('/') || 'Vault root', cls: 'crate-conflict-review-help' });
        body.createEl('p', { text: 'Choose which version to keep, or edit a combined result.', cls: 'crate-conflict-review-help' });
        const status = body.createDiv({ cls: 'crate-conflict-review-help', attr: { role: 'status', 'aria-live': 'polite' } });
        if (returning) status.setText('Versions refreshed. Review the latest content and choose a result. Your result draft, if any, is preserved.');
        const controls: Array<HTMLButtonElement | HTMLInputElement> = [];
        const button = (parent: HTMLElement, text: string, action: () => void) => {
            const el = parent.createEl('button', { text, attr: { type: 'button' } });
            el.addEventListener('click', action); controls.push(el); return el;
        };
        const textPreview = review.currentText !== undefined && review.savedText !== undefined;
        const diff = textPreview ? buildConflictDiff(review.currentText!, review.savedText!) : undefined;
        if (textPreview) body.createEl('p', {
            cls: 'crate-conflict-review-help',
            text: 'Comparing current file with saved copy. Red shows removed text · green shows added text.',
        });
        if (diff?.limited) body.createEl('p', { text: 'These versions are too different to highlight. Review the full text below.' });
        const compare = body.createDiv({ cls: 'crate-conflict-compare' });
        const previews: HTMLElement[] = [];
        for (const [version, title, size] of [
            ['current', 'Current file', review.currentSize], ['saved', 'Saved copy', review.savedSize],
        ] as const) {
            const panel = compare.createDiv({ cls: 'crate-conflict-version' });
            const heading = panel.createEl('h3');
            const open = button(heading, title, () => {
                this.awaitingExternal = true;
                void review.openVersion(version).catch((error: unknown) => {
                    this.awaitingExternal = false;
                    status.setText(error instanceof Error ? error.message : String(error));
                });
            });
            open.title = Platform.isDesktopApp ? 'Open in the default system application' : 'Open file in Obsidian';
            setIcon(open.createSpan({ attr: { 'aria-hidden': 'true' } }), 'external-link');
            const path = version === 'current' ? this.record.originalPath : this.record.conflictPath;
            const reveal = getPendingFileActions(this.app, path, () => {}).find(action => action.id === 'reveal');
            if (reveal) {
                const revealButton = button(panel, reveal.title, () => {
                    this.awaitingExternal = true;
                    void reveal.run().catch((error: unknown) => {
                        this.awaitingExternal = false;
                        status.setText(error instanceof Error ? error.message : String(error));
                    });
                });
                revealButton.addClass('crate-conflict-action');
                revealButton.setAttribute('aria-label', `${reveal.title}: ${title}`);
            }
            if (textPreview) {
                const code = panel.createEl('pre', { cls: 'crate-conflict-code', attr: { tabindex: '0', 'aria-label': title } });
                for (const row of diff!.rows) renderConflictDiffLine(code, row[version], version);
                previews.push(code);
                code.addEventListener('scroll', () => {
                    for (const other of previews) if (other !== code && other.scrollTop !== code.scrollTop) other.scrollTop = code.scrollTop;
                });
            } else panel.createEl('p', { text: `${Math.ceil(size / 1024)} KB · Select the title to open this file.` });
        }
        const manual = body.createDiv({ cls: 'crate-conflict-manual' });
        manual.createEl('h3', { text: 'Custom result' });
        const draftHelp = manual.createEl('p', { text: 'This draft starts with the current file’s text. Edit it to combine both versions, then save with ', cls: 'crate-conflict-review-help' });
        draftHelp.createEl('strong', { text: 'Resolve conflict' });
        draftHelp.append('.');
        const label = manual.createEl('label', { text: 'Result text' });
        const editor = label.createEl('textarea', { cls: 'crate-conflict-editor', attr: { 'aria-label': 'Result text', spellcheck: 'false' } });
        editor.value = this.draft ?? review.currentText ?? '';
        editor.addEventListener('input', () => { this.draft = editor.value; });
        const actions = this.contentEl.createDiv({ cls: 'crate-conflict-actions' });
        const choices = actions.createEl('fieldset', { cls: 'crate-conflict-choices' });
        choices.createEl('legend', { text: 'Resolution' });
        if (!textPreview && this.selected === 'manual') this.selected = undefined;
        const showResult = () => manual.toggle(this.selected === 'manual');
        showResult();
        const explanations = {
            current: 'Keep the current file. A recovery copy of the saved version is kept.',
            saved: 'Replace the current file with the saved copy. Recovery copies of both versions are kept.',
            both: 'Save both as separate files. The saved copy gets a new name.',
            manual: 'Save your edited result to the original file. Recovery copies of both versions are kept.',
        };
        const explanation = actions.createEl('p', { cls: 'crate-conflict-review-help crate-conflict-resolution-help' });
        const modes: Array<[ConflictChoice, string]> = [
            ['current', 'Keep current'], ['saved', 'Use saved copy'], ['both', 'Keep both'],
            ...(textPreview ? [['manual', 'Custom result'] as [ConflictChoice, string]] : []),
        ];
        explanation.setText(this.selected ? explanations[this.selected] : 'Select a resolution, then confirm. Recovery copies are kept on this device.');
        for (const [value, text] of modes) {
            const label = choices.createEl('label', { attr: { title: explanations[value] } });
            const radio = label.createEl('input', { attr: { type: 'radio', name: `resolution-${this.record.conflictPath}`, value } });
            label.createSpan({ cls: 'crate-conflict-choice-check', attr: { 'aria-hidden': 'true' } });
            label.createSpan({ text });
            radio.checked = this.selected === value;
            controls.push(radio);
            radio.addEventListener('change', () => {
                this.selected = value;
                if (value === 'manual') this.draft ??= editor.value;
                showResult();
                primary.disabled = false;
                explanation.setText(explanations[value]);
                if (value === 'manual') editor.focus();
            });
        }
        const primary = button(actions, 'Resolve conflict', () => { if (this.selected) void resolve(this.selected); });
        primary.addClass('crate-conflict-primary-action', 'crate-sync-primary-action'); primary.disabled = !this.selected;
        const resolve = async (choice: ConflictChoice) => {
            this.busy = true; controls.forEach(el => { el.disabled = true; }); editor.disabled = true;
            status.setText('Saving your choice…');
            try {
                await review.resolve(choice, editor.value);
                this.resolved();
                if (this.active) this.close();
                new Notice('Conflict resolved. Recovery copies saved on this device.');
            } catch (error) {
                status.setText(error instanceof Error ? error.message : String(error));
                const retry = status.createDiv({ cls: 'crate-conflict-retry' });
                this.addReloadButton(retry);
                controls.forEach(el => { el.disabled = false; }); editor.disabled = false;
            } finally { this.busy = false; }
        };
    }
    onClose(): void {
        this.active = false;
        this.contentEl.win.removeEventListener('focus', this.returnToReview);
        super.onClose();
    }
}
