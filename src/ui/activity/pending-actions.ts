import { Menu, Notice } from 'obsidian';
import type { PendingFileAction } from './file-actions';
import type { PendingRowSelection } from './pending-row-selection';

export interface PendingActions {
    syncSelected(keys: string[]): Promise<unknown>;
    discard(keys: string[]): void;
    fileActions?(path: string): PendingFileAction[];
}

/** Selection belongs to this open activity view, never to sync settings. */
export function createPendingActions(
    sidebar: HTMLElement, heading: HTMLElement, keys: string[], excluded: Set<string>, actions: PendingActions, rows: PendingRowSelection,
) {
    const selectAll = heading.createEl('label', { cls: 'crate-browser-select-all', attr: { title: 'Unchecked files stay pending. Selection applies to this sync only.' } });
    const all = selectAll.createEl('input', { attr: { type: 'checkbox', 'aria-label': 'Include all files in sync' } });
    selectAll.createSpan({ text: 'Include all' });
    heading.prepend(selectAll);
    const footer = sidebar.createDiv({ cls: 'crate-browser-actions' });
    const sync = footer.createEl('button', { cls: 'crate-browser-sync', attr: { type: 'button' } });
    const syncLabel = sync.createSpan({ text: 'Sync checked' });
    const syncCount = sync.createSpan({ cls: 'crate-browser-sync-count', attr: { 'aria-hidden': 'true' } });
    const status = footer.createDiv({ cls: 'crate-browser-action-status', attr: { role: 'status', 'aria-live': 'polite' } });
    const checkboxes = new Map<string, HTMLInputElement>();
    let busy = false;
    const checked = () => keys.filter(key => !excluded.has(key));
    const update = () => {
        const selected = checked();
        all.checked = selected.length === keys.length;
        all.indeterminate = selected.length > 0 && selected.length < keys.length;
        all.disabled = busy;
        for (const [key, input] of checkboxes) { input.checked = !excluded.has(key); input.disabled = busy; }
        syncLabel.textContent = busy ? 'Syncing…' : 'Sync checked';
        syncCount.textContent = String(selected.length);
        sync.setAttribute('aria-label', busy ? 'Syncing…' : `Sync checked (${selected.length})`);
        sync.disabled = busy || selected.length === 0;
    };
    all.addEventListener('change', () => {
        for (const key of keys) { if (all.checked) excluded.delete(key); else excluded.add(key); }
        update();
    });
    sync.addEventListener('click', () => {
        if (busy || !checked().length) return;
        const selected = checked();
        busy = true; status.textContent = ''; update();
        void actions.syncSelected(selected).catch((error: unknown) => {
            status.textContent = error instanceof Error ? error.message : 'Could not sync the selected files.';
        }).finally(() => { busy = false; update(); });
    });
    const contextMenu = (key: string) => {
        const targets = rows.contextTargets(key);
        const path = key.startsWith('delete:') ? key.slice(7) : key;
        const menu = new Menu();
        const fileActions = actions.fileActions?.(path) ?? [];
        for (const action of fileActions) menu.addItem(item => item.setTitle(action.title).setIcon(action.icon).onClick(() => {
            void action.run().catch((error: unknown) => new Notice(error instanceof Error ? error.message : 'Could not open this file.'));
        }));
        if (fileActions.length) menu.addSeparator();
        if (targets.length) menu.addItem(item => item
            .setTitle(`Discard ${targets.length} item${targets.length === 1 ? '' : 's'}…`)
            .setIcon('undo-2').setDisabled(busy).onClick(() => actions.discard(targets)));
        return menu;
    };
    update();
    return {
        toggleChecked: (key: string) => { checkboxes.get(key)?.click(); },
        addCheckbox: (row: HTMLElement, key: string) => {
            const path = key.startsWith('delete:') ? key.slice(7) : key;
            const label = row.createEl('label', { cls: 'crate-browser-file-check' });
            const input = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': `Sync ${path}` } });
            checkboxes.set(key, input); input.checked = !excluded.has(key);
            input.addEventListener('change', () => { if (input.checked) excluded.delete(key); else excluded.add(key); update(); });
        },
        bindContextMenu: (row: HTMLElement, key: string) => {
            row.addEventListener('contextmenu', event => {
                event.preventDefault();
                event.stopPropagation();
                contextMenu(key).showAtMouseEvent(event);
            });
            row.addEventListener('keydown', event => {
                if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
                    event.preventDefault();
                    event.stopPropagation();
                    const bounds = row.getBoundingClientRect();
                    contextMenu(key).showAtPosition({ x: bounds.left + 20, y: bounds.bottom });
                }
            });
        },
    };
}
