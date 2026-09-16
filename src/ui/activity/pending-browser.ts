import { setIcon } from 'obsidian';
import type { PendingDiff } from '../../sync/pending-diff';
import { buildDiff } from './diff-model';
import { renderDiffPreview } from './pending-diff';
import { PendingComparisons } from './pending-comparisons';
import { createPendingActions, type PendingActions } from './pending-actions';
import { createPendingRowSelection, type PendingRowSelectionState } from './pending-row-selection';

export type PendingDiffLoader = (path: string, deleted: boolean) => Promise<PendingDiff>;
export interface PendingBrowserState extends PendingRowSelectionState {
    selectedKey?: string;
    excludedKeys?: Set<string>;
    showDetail?: boolean;
    scrollTop?: number;
    startChecks?: () => void;
    pauseChecks?: () => void;
    dispose?: () => void;
}

let nextBrowserId = 0;

/** Check file statuses on opening; keep one selected comparison in view. */
export function renderPendingBrowser(container: HTMLElement, paths: string[], load: PendingDiffLoader, state: PendingBrowserState = {}, actions?: PendingActions): void {
    const browser = container.createDiv({ cls: 'crate-pending-browser' });
    const sidebar = browser.createDiv({ cls: 'crate-browser-sidebar' });
    const heading = sidebar.createDiv({ cls: 'crate-browser-list-heading' });
    if (!actions) heading.createSpan({ text: 'Files' });
    heading.createSpan({ text: String(paths.length), cls: 'crate-browser-count' });
    const list = sidebar.createEl('nav', { cls: 'crate-browser-files', attr: { 'aria-label': 'Pending files' } });
    const listHint = sidebar.createDiv({ cls: 'crate-browser-list-hint', text: actions ? 'Checkboxes include files in sync. Space toggles the focused checkbox. Command or Control+A highlights all files. Shift-click selects a range; Command or Control-click selects individual files. Right-click or press Shift+F10 for actions on highlighted files.' : 'Touched files stay here until sync.' });
    listHint.id = `crate-pending-hint-${++nextBrowserId}`;
    list.setAttribute('aria-describedby', listHint.id);

    const rowSelection = createPendingRowSelection(sidebar, paths, state);
    const selection = actions ? createPendingActions(sidebar, heading, paths, state.excludedKeys ??= new Set(), actions, rowSelection) : undefined;

    const detail = browser.createDiv({ cls: 'crate-browser-detail', attr: { role: 'region', 'aria-label': 'File comparison' } });
    detail.id = `crate-pending-detail-${nextBrowserId}`;
    const toolbar = detail.createDiv({ cls: 'crate-browser-toolbar' });
    const back = toolbar.createEl('button', { cls: 'crate-browser-back', attr: { type: 'button', 'aria-label': 'Back to files' } });
    setIcon(back.createSpan({ attr: { 'aria-hidden': 'true' } }), 'arrow-left');
    back.createSpan({ text: 'Files' });
    const fileInfo = toolbar.createDiv({ cls: 'crate-browser-file-heading' });
    const fileName = fileInfo.createDiv({ cls: 'crate-browser-file-title' });
    const filePath = fileInfo.createDiv({ cls: 'crate-browser-file-folder' });
    const comparisonHeader = toolbar.createDiv({ cls: 'crate-diff-header' });
    toolbar.hidden = true;
    const preview = detail.createDiv({ cls: 'crate-file-diff' });
    const empty = preview.createDiv({ cls: 'crate-browser-empty' });
    setIcon(empty.createSpan({ cls: 'crate-browser-empty-icon', attr: { 'aria-hidden': 'true' } }), 'file-diff');
    empty.createDiv({ text: 'Select a file', cls: 'crate-browser-empty-title' });
    empty.createDiv({ text: 'Compare the server copy with this device.' });

    let requestRevision = 0;
    let selectedIndex = -1;
    const rows: Array<{ button: HTMLButtonElement; status: HTMLSpanElement }> = [];
    const comparisons = new PendingComparisons(paths.length, index => {
        const key = paths[index]!;
        return load(key.startsWith('delete:') ? key.slice(7) : key, key.startsWith('delete:'));
    }, (index, snapshot) => {
        if (!browser.isConnected) return;
        const status = rows[index]!.status;
        status.textContent = describeSnapshot(snapshot);
        status.title = status.textContent;
        status.classList.toggle('is-unchanged', status.textContent === 'Unchanged');
    }, index => {
        if (browser.isConnected) rows[index]!.status.textContent = 'Unavailable';
    });
    state.startChecks = () => comparisons.start();
    state.pauseChecks = () => comparisons.pause();
    state.dispose = () => comparisons.dispose();
    const showFiles = () => {
        state.showDetail = false;
        browser.classList.remove('is-reviewing');
        rows[selectedIndex]?.button.focus({ preventScroll: true });
    };
    back.addEventListener('click', showFiles);
    detail.addEventListener('keydown', event => {
        if (event.key === 'Escape' && back.getClientRects().length > 0) {
            event.preventDefault();
            event.stopPropagation();
            showFiles();
        }
    });

    const select = async (index: number, moveFocus = true) => {
        const key = paths[index];
        const row = rows[index];
        if (!key || !row) return;
        selectedIndex = index;
        state.selectedKey = key;
        if (moveFocus) state.showDetail = true;
        browser.classList.toggle('is-reviewing', !!state.showDetail);
        const deleted = key.startsWith('delete:');
        const path = deleted ? key.slice(7) : key;
        const parts = path.split('/');
        fileName.textContent = parts.pop() ?? path;
        filePath.textContent = parts.join('/') || 'Vault root';
        filePath.title = path;
        toolbar.hidden = false;
        rows.forEach((item, i) => {
            item.button.tabIndex = i === index ? 0 : -1;
        });
        comparisonHeader.empty();
        preview.empty();
        preview.createDiv({ cls: 'crate-diff-message', text: 'Loading changes…', attr: { role: 'status' } });
        preview.setAttribute('aria-busy', 'true');
        if (moveFocus && back.getClientRects().length > 0) back.focus({ preventScroll: true });
        const revision = ++requestRevision;
        try {
            const snapshot = await comparisons.read(index);
            if (!browser.isConnected || revision !== requestRevision) return;
            preview.empty();
            renderDiffPreview(preview, snapshot, path, comparisonHeader);
        } catch (error) {
            if (!browser.isConnected || revision !== requestRevision) return;
            preview.empty();
            row.status.textContent = 'Unavailable';
            const message = preview.createDiv({ cls: 'crate-diff-message', attr: { role: 'status' } });
            message.createSpan({ text: error instanceof Error ? error.message : 'Could not load changes.' });
            const retry = message.createEl('button', { text: 'Try again', attr: { type: 'button' } });
            retry.addEventListener('click', () => { void select(index, false); });
        } finally {
            if (browser.isConnected && revision === requestRevision) {
                preview.removeAttribute('aria-busy');
            }
        }
    };

    paths.forEach((key, index) => {
        const deleted = key.startsWith('delete:');
        const path = deleted ? key.slice(7) : key;
        const parts = path.split('/');
        const row = actions ? list.createDiv({ cls: 'crate-browser-file-row' }) : list;
        selection?.addCheckbox(row, key);
        selection?.bindContextMenu(row, key);
        const button = row.createEl('button', { cls: 'crate-browser-file', attr: {
            type: 'button', 'aria-label': `${deleted ? 'Review deletion of' : 'Review changes for'} ${path}`,
            'aria-pressed': 'false', 'aria-controls': detail.id,
        } });
        button.tabIndex = index === 0 ? 0 : -1;
        if (selection) button.setAttribute('aria-keyshortcuts', 'Space');
        if (!actions) setIcon(button.createSpan({ cls: 'crate-browser-file-icon', attr: { 'aria-hidden': 'true' } }), deleted ? 'trash-2' : 'file-text');
        const info = button.createSpan({ cls: 'crate-browser-file-info' });
        info.createSpan({ cls: 'crate-browser-file-name', text: parts.pop() ?? path, attr: { title: path } });
        const meta = info.createSpan({ cls: 'crate-browser-file-meta' });
        meta.createSpan({ cls: 'crate-browser-file-path', text: parts.join('/') || 'Vault root' });
        const status = meta.createSpan({ cls: 'crate-browser-file-status', text: 'Checking…' });
        status.id = `${detail.id}-status-${index}`;
        button.setAttribute('aria-describedby', status.id);
        rows.push({ button, status });
        rowSelection.addButton(key, button);
        button.addEventListener('click', event => {
            rowSelection.choose(index, event);
            void select(index, !event.shiftKey && !event.metaKey && !event.ctrlKey);
        });
        button.addEventListener('keyup', event => {
            if (selection && event.key === ' ') event.preventDefault();
        });
        button.addEventListener('keydown', event => {
            if (selection && event.key === ' ') {
                event.preventDefault();
                if (!event.repeat) selection.toggleChecked(key);
                return;
            }
            let next = index;
            if (event.key === 'ArrowDown') next = Math.min(index + 1, paths.length - 1);
            else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = paths.length - 1;
            else return;
            event.preventDefault();
            state.anchorKey ??= key;
            rowSelection.choose(next, { shiftKey: event.shiftKey });
            rows.forEach((item, i) => { item.button.tabIndex = i === next ? 0 : -1; });
            rows[next]?.button.focus();
            // Desktop previews follow arrow navigation; mobile waits for activation.
            if (browser.clientWidth > 640) void select(next, false);
        });
    });
    list.scrollTop = state.scrollTop ?? 0;
    list.addEventListener('scroll', () => { state.scrollTop = list.scrollTop; });
    const previousIndex = paths.findIndex(key => key === state.selectedKey);
    if (previousIndex >= 0) void select(previousIndex, false);
    else { state.selectedKey = undefined; state.showDetail = false; }
    queueMicrotask(() => {
        if (browser.isConnected && browser.getClientRects().length > 0) comparisons.start();
    });
}

function describeSnapshot(snapshot: PendingDiff): string {
    if (snapshot.unchanged) return 'Unchanged';
    if (snapshot.unavailable || snapshot.before === undefined || snapshot.after === undefined) return 'No preview';
    if (snapshot.kind === 'added') return 'Added';
    if (snapshot.kind === 'deleted') return 'Deleted';
    if (snapshot.before === snapshot.after) return 'Unchanged';
    const diff = buildDiff(snapshot.before, snapshot.after);
    if (diff.limited) return 'Modified';
    return `+${diff.added} −${diff.removed}`;
}
