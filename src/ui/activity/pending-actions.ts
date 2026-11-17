import { Menu, Notice, Platform, setIcon } from 'obsidian';
import { decodePendingChange } from '../../sync/pending/pending-change';
import type { PendingFileAction } from './file-actions';
import type { PendingRowSelection } from './pending-row-selection';
import { describeSyncSelection } from './activity-status';

/** The Pending tab's one sync control. */
export interface PendingSyncAction {
	/** The button's state from sync status. While `idle` it starts a sync; otherwise it stops one or waits. */
	describe(): { label: string; disabled: boolean; idle: boolean };
	/** Starts a sync that leaves the `held` pending keys alone, or stops the running sync. */
	run(held: string[]): void;
}

export interface PendingActions {
	sync: PendingSyncAction;
	discard(keys: string[]): void;
	fileActions?(path: string): PendingFileAction[];
}

/** The sync button for a Pending tab without a file list, as when nothing is pending or
 * a sync is running. Returns its update, for sync state changes. */
export function renderPendingSyncButton(parent: HTMLElement, action: PendingSyncAction): () => void {
	const button = parent.createEl('button', { cls: 'crate-sync-primary-action crate-pending-sync-action', attr: { type: 'button' } });
	const update = () => {
		const state = action.describe();
		const { label, title } = state.idle ? describeSyncSelection(0, 0) : { label: state.label, title: state.label };
		button.textContent = label;
		button.setAttribute('title', title);
		button.disabled = state.disabled;
	};
	button.addEventListener('click', () => action.run([]));
	update();
	return update;
}

/** Selection belongs to this open activity view, never to sync settings. */
export function createPendingActions(
	sidebar: HTMLElement, heading: HTMLElement, keys: string[], excluded: Set<string>, actions: PendingActions, rows: PendingRowSelection,
) {
	const selectAll = heading.createEl('label', { cls: 'crate-browser-select-all', attr: { title: 'Choose files to sync with the button below. Unchecked files stay on this device.' } });
	const all = selectAll.createEl('input', { attr: { type: 'checkbox', 'aria-label': 'Select all files for sync' } });
	selectAll.createSpan({ text: 'Select all' });
	heading.prepend(selectAll);
	const count = heading.createSpan({ cls: 'crate-browser-selection-count', attr: { role: 'status' } });
	const footer = sidebar.createDiv({ cls: 'crate-browser-actions' });
	const sync = footer.createEl('button', { cls: 'crate-browser-sync', attr: { type: 'button' } });
	const syncLabel = sync.createSpan({ cls: 'crate-browser-sync-label', text: 'Sync' });
	// A few words on the running sync, such as a file count; the header names the phase.
	const syncDetail = sync.createSpan({ cls: 'crate-browser-sync-detail' });
	const checkboxes = new Map<string, HTMLInputElement>();
	// A running sync locks the selection and shows its progress on the button.
	let progress: { label: string; fraction?: number } | undefined;
	const locked = () => !!progress || !actions.sync.describe().idle;
	const checked = () => keys.filter(key => !excluded.has(key));
	const update = () => {
		const selected = checked();
		const action = actions.sync.describe();
		all.checked = selected.length === keys.length;
		all.indeterminate = selected.length > 0 && selected.length < keys.length;
		all.disabled = locked();
		for (const [key, input] of checkboxes) { input.checked = !excluded.has(key); input.disabled = locked(); }
		count.textContent = `${selected.length} of ${keys.length} files selected`;
		const { label, title } = action.idle ? describeSyncSelection(selected.length, keys.length) : { label: action.label, title: action.label };
		// Only Stop sync carries the detail; Stopping… stands alone.
		const detail = action.idle || action.disabled ? '' : progress?.label ?? '';
		syncLabel.textContent = label;
		syncDetail.textContent = detail;
		sync.setAttribute('aria-label', detail ? `${label}, ${detail}` : label);
		sync.title = title;
		sync.disabled = action.disabled;
		sync.toggleClass('is-syncing', !!progress);
		sync.setCssProps({ '--crate-sync-progress': progress?.fraction === undefined ? '0' : String(progress.fraction) });
	};
	all.addEventListener('change', () => {
		for (const key of keys) { if (all.checked) excluded.delete(key); else excluded.add(key); }
		update();
	});
	sync.addEventListener('click', () => {
		if (!sync.disabled) actions.sync.run(keys.filter(key => excluded.has(key)));
	});
	const contextMenu = (key: string) => {
		const targets = rows.contextTargets(key);
		const { path } = decodePendingChange(key);
		const menu = new Menu();
		const fileActions = actions.fileActions?.(path) ?? [];
		for (const action of fileActions) menu.addItem(item => item.setTitle(action.title).setIcon(action.icon).onClick(() => {
			void action.run().catch((error: unknown) => new Notice(error instanceof Error ? error.message : 'Could not open this file.'));
		}));
		if (fileActions.length) menu.addSeparator();
		if (targets.length) menu.addItem(item => item
			.setTitle(`Discard ${targets.length} item${targets.length === 1 ? '' : 's'}…`)
			.setIcon('undo-2').setDisabled(locked()).onClick(() => actions.discard(targets)));
		return menu;
	};
	update();
	return {
		setProgress: (next?: { label: string; fraction?: number }) => { progress = next; update(); },
		update,
		toggleChecked: (key: string) => { checkboxes.get(key)?.click(); },
		removeRow: (key: string) => { checkboxes.delete(key); },
		addCheckbox: (row: HTMLElement, key: string) => {
			const { path } = decodePendingChange(key);
			const label = row.createEl('label', { cls: 'crate-browser-file-check' });
			const input = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': `Sync ${path}` } });
			checkboxes.set(key, input); input.checked = !excluded.has(key);
			input.addEventListener('change', () => { if (input.checked) excluded.delete(key); else excluded.add(key); update(); });
		},
		// Touch hosts have no reliable context menu, so each row gets a visible menu button.
		addMenuButton: (row: HTMLElement, key: string) => {
			if (!Platform.isMobile) return;
			const { path } = decodePendingChange(key);
			const button = row.createEl('button', { cls: 'crate-browser-file-menu', attr: { type: 'button', 'aria-label': `More actions for ${path}`, 'aria-haspopup': 'menu' } });
			setIcon(button, 'more-horizontal');
			button.addEventListener('click', event => {
				event.stopPropagation();
				const bounds = button.getBoundingClientRect();
				contextMenu(key).showAtPosition({ x: bounds.right, y: bounds.bottom });
			});
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
