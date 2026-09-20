import { setIcon } from 'obsidian';
import type { SyncHistoryEntry } from '../../sync/types';
import type { HistoryComparison } from '../../sync/history-comparison';
import { groupHistory } from './history-groups';
import { historyEntryKey } from './history-point';
import { describeHistory, historyTime, recordedHistoryFiles } from './history';
import { renderHistoryPreview } from './history-preview';

export interface HistoryBrowserDeps {
    load?(entry: SyncHistoryEntry, previous?: SyncHistoryEntry): Promise<HistoryComparison>;
    restore?(entry: SyncHistoryEntry): void;
    openFile?(path: string): void;
}

/** A mounted browser keeps selection and requests stable across sync progress updates. */
export class HistoryBrowser {
    private entries: SyncHistoryEntry[] = [];
    private selected?: SyncHistoryEntry;
    private selectedPath?: string;
    private comparison?: HistoryComparison;
    private revision = 0;
    private previewRevision = 0;
    private signature = '';
    private selectionSignature = '';
    private disposed = false;
    private syncs: HTMLElement;
    private files: HTMLElement;
    private preview: HTMLElement;
    private footer: HTMLElement;
    private fileLimit = 200;
    private items: Array<{ path: string; action: string }> = [];

    constructor(private container: HTMLElement, private deps: HistoryBrowserDeps) {
        container.addClass('crate-file-history', 'crate-history-browser');
        container.empty();
        const workspace = container.createDiv({ cls: 'crate-history-browser-workspace' });
        this.syncs = workspace.createEl('nav', { cls: 'crate-history-syncs', attr: { 'aria-label': 'Sync history' } });
        this.files = workspace.createEl('nav', { cls: 'crate-history-event-files', attr: { 'aria-label': 'Files in selected sync' } });
        this.preview = workspace.createDiv({ cls: 'crate-history-preview-pane' });
        this.footer = container.createDiv({ cls: 'crate-history-browser-footer' });
        this.showPane('history');
        this.preview.createEl('p', { text: 'Select a sync to see its files and changes.', cls: 'crate-history-description' });
    }

    update(history: SyncHistoryEntry[]): void {
        if (this.disposed) return;
        const signature = JSON.stringify(history);
        if (signature === this.signature) return;
        this.signature = signature;
        this.entries = groupHistory(history).flatMap(group => group.rows.map(row => row.entry));
        const key = this.selected && historyEntryKey(this.selected);
        this.selected = this.entries.find(entry => historyEntryKey(entry) === key) ?? this.entries[0];
        this.renderSyncs(history);
        if (!this.selected) {
            this.revision++; this.previewRevision++;
            this.files.empty(); this.preview.empty(); this.footer.empty();
            this.preview.createEl('p', { text: 'Sync history will appear here.', cls: 'crate-history-description' });
            this.selectionSignature = '';
            return;
        }
        const selection = JSON.stringify([this.selected, this.previous()]);
        if (selection !== this.selectionSignature) {
            this.selectionSignature = selection;
            void this.select(this.selected, false);
        }
    }

    private previous(): SyncHistoryEntry | undefined {
        const index = this.entries.indexOf(this.selected!);
        return this.entries.slice(index + 1).find(entry => entry.sharedCheckpoint || entry.historyCheckpoint);
    }

    private showPane(pane: 'history' | 'files' | 'diff'): void { this.container.setAttribute('data-pane', pane); }

    private back(parent: HTMLElement, label: string, pane: 'history' | 'files'): void {
        const button = parent.createEl('button', { cls: 'crate-history-pane-back', attr: { type: 'button', 'aria-label': `Back to ${label.toLowerCase()}` } });
        setIcon(button.createSpan({ attr: { 'aria-hidden': 'true' } }), 'arrow-left');
        button.createSpan({ text: label });
        button.addEventListener('click', () => {
            this.showPane(pane);
            (pane === 'history' ? this.syncs : this.files).querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
        });
    }

    private renderSyncs(history: SyncHistoryEntry[]): void {
        this.syncs.empty();
        if (!history.length) this.syncs.createEl('p', { text: 'No activity yet', cls: 'crate-history-description' });
        for (const group of groupHistory(history)) {
            this.syncs.createEl('h3', { text: group.label, cls: 'crate-history-group' });
            for (const { entry, count } of group.rows) {
                const key = historyEntryKey(entry);
                const button = this.syncs.createEl('button', { cls: 'crate-history-version', attr: { type: 'button', 'data-history-key': key, 'aria-current': String(key === (this.selected && historyEntryKey(this.selected))) } });
                button.createSpan({ text: describeHistory(entry, count), cls: 'crate-history-file-name' });
                button.createSpan({ text: `${entry.type === 'initial' ? 'Initial sync · ' : entry.type === 'force' ? 'Full sync · ' : ''}${historyTime(entry)}`, cls: 'crate-history-file-folder', attr: { title: new Date(entry.timestamp).toLocaleString() } });
                if (entry.checkpointFileCount !== undefined) {
                    button.createSpan({ text: 'Sync details unavailable on this device', cls: 'crate-history-file-folder' });
                }
                button.addEventListener('click', () => {
                    for (const row of Array.from(this.syncs.querySelectorAll('[aria-current]'))) row.setAttribute('aria-current', String(row === button));
                    void this.select(this.entries.find(saved => historyEntryKey(saved) === key)!, true);
                });
            }
        }
    }

    private async select(entry: SyncHistoryEntry, navigate: boolean): Promise<void> {
        const revision = ++this.revision;
        this.previewRevision++;
        this.selected = entry;
        this.selectionSignature = JSON.stringify([entry, this.previous()]);
        this.selectedPath = undefined; this.comparison = undefined; this.fileLimit = 200;
        this.items = recordedHistoryFiles(entry);
        if (navigate) this.showPane('files');
        this.renderFiles('Loading saved state…', false);
        this.preview.empty();
        this.preview.createEl('p', { text: 'Loading saved state…', cls: 'crate-history-description', attr: { role: 'status' } });
        this.renderFooter();
        if (navigate) this.files.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
        try {
            if (!entry.sharedCheckpoint && !entry.historyCheckpoint) throw new Error('No saved state for this sync. Recorded files may be incomplete.');
            if (!this.deps.load) throw new Error('Saved-state previews are unavailable.');
            const comparison = await this.deps.load(entry, this.previous());
            if (this.disposed || revision !== this.revision) return;
            this.comparison = comparison;
            this.items = comparison.items.map(item => ({ ...item, action: { added: 'Added', modified: 'Modified', deleted: 'Deleted', saved: 'Saved' }[item.action] }));
            this.renderFiles(comparison.notice, comparison.retryable);
            if (this.items[0]) void this.selectFile(this.items[0].path, false);
            else {
                this.preview.empty();
                this.back(this.preview, 'Files', 'files');
                this.preview.createEl('p', { text: comparison.compared ? 'No file changes between these saved states.' : 'This saved state has no files.', cls: 'crate-history-description' });
            }
        } catch (error) {
            if (this.disposed || revision !== this.revision) return;
            const message = error instanceof Error ? error.message : 'Could not load this sync.';
            this.renderFiles(message, true);
            this.preview.empty();
            this.back(this.preview, 'Files', 'files');
            this.preview.createEl('p', { text: message, cls: 'crate-history-description', attr: { role: 'status' } });
        }
    }

    private renderFiles(notice?: string, retryable = false): void {
        const scrollTop = this.files.scrollTop;
        const focusHeader = this.files.querySelector('h3') === this.files.ownerDocument.activeElement;
        this.files.empty();
        this.back(this.files, 'History', 'history');
        const heading = this.files.createEl('h3', { text: `${this.comparison && !this.comparison.compared ? 'Saved files' : 'Files'} · ${this.items.length}`, cls: 'crate-history-group', attr: { tabindex: '-1' } });
        if (focusHeader) heading.focus({ preventScroll: true });
        if (notice) {
            const status = this.files.createDiv({ cls: 'crate-history-state-notice' });
            status.createEl('p', { text: notice, cls: 'crate-history-description', attr: { role: 'status' } });
            if (retryable && (this.selected?.sharedCheckpoint || this.selected?.historyCheckpoint)) {
                const retry = status.createEl('button', { text: 'Retry loading', cls: 'crate-activity-action', attr: { type: 'button' } });
                retry.addEventListener('click', () => { void this.select(this.selected!, false); });
            }
        }
        for (const message of this.selected?.errors ?? []) this.files.createEl('p', { text: message, cls: 'crate-history-description' });
        if (this.selected && this.selected.errorCount > (this.selected.errors?.length ?? 0)) {
            this.files.createEl('p', { text: 'Some error details were not saved for this sync.', cls: 'crate-history-description' });
        }
        for (const item of this.items.slice(0, this.fileLimit)) {
            const button = this.files.createEl('button', { cls: 'crate-history-version', attr: { type: 'button', 'aria-label': `View ${item.path}`, 'aria-current': String(item.path === this.selectedPath) } });
            button.createSpan({ text: item.path.split('/').pop()!, cls: 'crate-history-file-name' });
            button.createSpan({ text: [item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '', item.action].filter(Boolean).join(' · '), cls: 'crate-history-file-folder' });
            button.addEventListener('click', () => { void this.selectFile(item.path, true); });
        }
        if (this.items.length > this.fileLimit) {
            const more = this.files.createEl('button', { text: 'More files', cls: 'crate-activity-action', attr: { type: 'button' } });
            more.addEventListener('click', () => { this.fileLimit += 200; this.renderFiles(this.comparison?.notice, this.comparison?.retryable); });
        }
        this.files.scrollTop = scrollTop;
    }

    private async selectFile(path: string, navigate: boolean): Promise<void> {
        const revision = ++this.previewRevision;
        this.selectedPath = path;
        for (const button of Array.from(this.files.querySelectorAll('[aria-current]'))) button.setAttribute('aria-current', String(button.getAttribute('aria-label') === `View ${path}`));
        if (navigate) this.showPane('diff');
        this.preview.empty();
        this.back(this.preview, 'Files', 'files');
        const header = this.preview.createDiv({ cls: 'crate-history-preview-header' });
        const title = header.createEl('h3', { text: path, attr: { tabindex: '-1' } });
        if (navigate) title.focus({ preventScroll: true });
        const caption = header.createDiv({ cls: 'crate-history-comparison' });
        caption.createSpan({ text: this.comparison?.compared ? 'Previous saved state → Selected sync' : 'Saved contents' });
        const counts = caption.createSpan({ cls: 'crate-history-diff-summary' });
        const output = this.preview.createDiv({ cls: 'crate-history-preview-output crate-history-diff crate-file-diff' });
        const status = output.createEl('p', { text: 'Loading file…', cls: 'crate-history-description', attr: { role: 'status' } });
        this.renderFooter();
        try {
            if (!this.comparison) throw new Error('The saved contents for this sync are unavailable.');
            const snapshot = await this.comparison.preview(path);
            if (this.disposed || revision !== this.previewRevision) return;
            renderHistoryPreview(output, snapshot, counts, `Changes in selected sync: ${path}`, this.comparison.compared);
        } catch (error) {
            if (this.disposed || revision !== this.previewRevision) return;
            status.setText(error instanceof Error ? error.message : 'Could not load this file.');
            if (this.comparison) {
                const retry = output.createEl('button', { text: 'Retry preview', cls: 'crate-activity-action', attr: { type: 'button' } });
                retry.addEventListener('click', () => { void this.selectFile(path, false); });
            }
        }
    }

    private renderFooter(): void {
        this.footer.empty();
        if (!this.selected) return;
        this.footer.createSpan({ text: `${describeHistory(this.selected)} · ${historyTime(this.selected)}`, cls: 'crate-history-hint' });
        const actions = this.footer.createDiv({ cls: 'crate-history-browser-actions' });
        const path = this.selectedPath;
        if (path && this.deps.openFile) {
            const file = actions.createEl('button', { text: 'File history', cls: 'crate-activity-action', attr: { type: 'button' } });
            file.addEventListener('click', () => this.deps.openFile!(path));
        }
        const entry = this.selected;
        if ((entry.sharedCheckpoint || entry.historyCheckpoint) && this.deps.restore) {
            const restore = actions.createEl('button', { text: 'Restore to this point', cls: 'crate-activity-action', attr: { type: 'button' } });
            restore.addEventListener('click', () => this.deps.restore!(entry));
        }
    }

    dispose(): void { this.disposed = true; this.revision++; this.previewRevision++; }
}
