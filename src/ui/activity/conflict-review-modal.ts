import { Notice, Platform, setIcon, type App } from 'obsidian';
import type { ConflictRecord } from '../../sync/types';
import type { ConflictChoice, ConflictReview } from '../../sync/conflict-review';
import { diffSequence } from '../../sync/text-diff';
import { SharedModal } from '../shared/SharedModal';

export class ConflictReviewModal extends SharedModal {
    private active = true;
    private busy = false;
    private revision = 0;
    private draft: string | undefined;
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
        this.contentEl.win.addEventListener('focus', this.returnToReview);
        void this.refresh();
    }
    private async refresh(returning = false): Promise<void> {
        if (this.busy) return;
        const revision = ++this.revision;
        this.bodyEl.setText('Loading both versions…');
        try {
            const review = await this.load();
            if (this.active && revision === this.revision) this.render(review, returning);
        } catch (error) {
            if (this.active && revision === this.revision) {
                this.bodyEl.setText(error instanceof Error ? error.message : String(error));
                this.addReloadButton(this.bodyEl);
            }
        }
    }
    private addReloadButton(parent: HTMLElement): void {
        const reload = parent.createEl('button', { text: 'Reload versions', attr: { type: 'button' } });
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
        body.createEl('p', { text: 'Choose a version or edit a combined result. Recovery copies are kept on this device.', cls: 'crate-conflict-review-help' });
        const status = body.createDiv({ cls: 'crate-conflict-review-help', attr: { role: 'status', 'aria-live': 'polite' } });
        if (returning) status.setText('Versions refreshed. Review the latest content and choose a result. Your inline draft, if any, is preserved.');
        const controls: Array<HTMLButtonElement | HTMLInputElement> = [];
        const button = (parent: HTMLElement, text: string, action: () => void) => {
            const el = parent.createEl('button', { text, attr: { type: 'button' } });
            el.addEventListener('click', action); controls.push(el); return el;
        };
        const compare = body.createDiv({ cls: 'crate-conflict-compare' });
        const markdown = review.currentText !== undefined && review.savedText !== undefined;
        const left = review.currentText?.split('\n') ?? [], right = review.savedText?.split('\n') ?? [];
        const changedLeft = new Set<number>(), changedRight = new Set<number>();
        let offset = 0;
        if (markdown) for (const hunk of diffSequence(left, right)) {
            for (let i = hunk.start; i < hunk.end; i++) changedLeft.add(i);
            for (let i = 0; i < hunk.replacement.length; i++) changedRight.add(hunk.start + offset + i);
            offset += hunk.replacement.length - (hunk.end - hunk.start);
        }
        for (const [version, title, lines, changed, size] of [
            ['current', 'Current file', left, changedLeft, review.currentSize], ['saved', 'Saved copy', right, changedRight, review.savedSize],
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
            if (markdown) {
                const code = panel.createEl('pre', { cls: 'crate-conflict-code', attr: { tabindex: '0', 'aria-label': title } });
                lines.forEach((line, index) => code.createDiv({ text: line || ' ', cls: changed.has(index) ? 'crate-conflict-changed' : '' }));
            } else panel.createEl('p', { text: `${Math.ceil(size / 1024)} KB · Select the title to open this file.` });
        }
        const toolbar = intro.createDiv({ cls: 'crate-conflict-toolbar' });
        const manual = body.createDiv({ cls: 'crate-conflict-manual' });
        manual.hide();
        const label = manual.createEl('label', { text: 'Result — saved to the original file' });
        const editor = label.createEl('textarea', { cls: 'crate-conflict-editor', attr: { 'aria-label': 'Result Markdown', spellcheck: 'false' } });
        editor.value = this.draft ?? review.currentText ?? '';
        editor.addEventListener('input', () => { this.draft = editor.value; });
        const actions = body.createDiv({ cls: 'crate-conflict-actions' });
        const choices = actions.createEl('fieldset', { cls: 'crate-conflict-choices' });
        choices.createEl('legend', { text: 'Keep in your vault' });
        let selected: ConflictChoice | undefined;
        const radios: HTMLInputElement[] = [];
        const explanations = {
            current: 'Keep the current file. A recovery copy of the saved version is kept.',
            saved: 'Replace the current file with the saved copy. Recovery copies of both versions are kept.',
            both: 'Keep the current file and save the other version under a new name.',
        };
        const explanation = actions.createEl('p', { cls: 'crate-conflict-review-help crate-conflict-resolution-help' });
        for (const [value, text] of [['current', 'Keep current'], ['saved', 'Use saved copy'], ['both', 'Keep both']] as const) {
            const label = choices.createEl('label');
            const radio = label.createEl('input', { attr: { type: 'radio', name: `resolution-${this.record.conflictPath}`, value } });
            label.createSpan({ text }); controls.push(radio); radios.push(radio);
            radio.addEventListener('change', () => {
                selected = value; manual.hide(); primary.textContent = 'Resolve conflict'; primary.disabled = false;
                explanation.setText(explanations[value]);
            });
        }
        if (markdown) button(toolbar, 'Edit result', () => {
            selected = 'manual'; radios.forEach(radio => { radio.checked = false; });
            manual.show(); primary.textContent = 'Save and resolve'; primary.disabled = false;
            explanation.setText('Save the edited Markdown to the original file and keep recovery copies of both previous versions.');
            editor.focus();
        });
        const primary = button(actions, 'Resolve conflict', () => { if (selected) void resolve(selected); });
        primary.addClass('mod-cta'); primary.disabled = true;
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
                this.addReloadButton(status);
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
