import { Menu, Notice, Platform, setIcon } from 'obsidian';
import type { PendingFileAction } from './file-actions';
import type { PendingItem } from './pending-items';
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
	/** Automatic sync uploads every pending file soon after it changes, so the list
	 * offers no checkboxes: an unchecked file would upload on the next sync anyway. */
	automaticSync?: boolean;
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

/** Selection belongs to this open activity view, never to sync settings. Each row checks
 * all of its pending keys together; `excluded` holds pending keys, not rows. */
export function createPendingActions(
	sidebar: HTMLElement, heading: HTMLElement, items: PendingItem[], excluded: Set<string>, actions: PendingActions, rows: PendingRowSelection,
) {
	const checkable = !actions.automaticSync;
	const keys = items.flatMap(item => item.keys);
	const byKey = new Map(items.map(item => [item.key, item]));
	// Rows count as files until a plugin row groups several.
	const noun = items.every(item => !item.plugin) ? 'file' : 'item';
	const included = (item: PendingItem) => item.keys.every(key => !excluded.has(key));
	const include = (item: PendingItem, on: boolean) => { for (const key of item.keys) { if (on) excluded.delete(key); else excluded.add(key); } };
	let all: HTMLInputElement | undefined;
	let count: HTMLSpanElement | undefined;
	if (checkable) {
		const selectAll = heading.createEl('label', { cls: 'crate-browser-select-all', attr: { title: 'Choose files to sync with the button below. Unchecked files stay on this device.' } });
		all = selectAll.createEl('input', { attr: { type: 'checkbox', 'aria-label': 'Select all files for sync' } });
		selectAll.createSpan({ text: 'Select all' });
		heading.prepend(selectAll);
		count = heading.createSpan({ cls: 'crate-browser-selection-count', attr: { role: 'status' } });
	} else {
		const note = heading.createSpan({ cls: 'crate-browser-auto-sync-note' });
		setIcon(note.createSpan({ cls: 'crate-browser-auto-sync-icon', attr: { 'aria-hidden': 'true' } }), 'refresh-cw');
		note.createSpan({ text: 'Changes sync automatically' });
	}
	const footer = sidebar.createDiv({ cls: 'crate-browser-actions' });
	const sync = footer.createEl('button', { cls: 'crate-browser-sync', attr: { type: 'button' } });
	const syncLabel = sync.createSpan({ cls: 'crate-browser-sync-label', text: 'Sync' });
	// A few words on the running sync, such as a file count; the header names the phase.
	const syncDetail = sync.createSpan({ cls: 'crate-browser-sync-detail' });
	const checkboxes = new Map<string, HTMLInputElement>();
	// A running sync locks the selection and shows its progress on the button.
	let progress: { label: string; fraction?: number } | undefined;
	const locked = () => !!progress || !actions.sync.describe().idle;
	const update = () => {
		const selected = items.filter(included);
		const action = actions.sync.describe();
		if (all && count) {
			all.checked = selected.length === items.length;
			all.indeterminate = selected.length > 0 && selected.length < items.length;
			all.disabled = locked();
			count.textContent = `${selected.length} of ${items.length} ${noun}s selected`;
		}
		for (const [key, input] of checkboxes) { input.checked = included(byKey.get(key)!); input.disabled = locked(); }
		const { label, title } = !action.idle ? { label: action.label, title: action.label }
			: checkable ? describeSyncSelection(selected.length, items.length, noun)
				: { label: 'Sync now', title: 'Upload these files and get changes from your other devices.' };
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
	all?.addEventListener('change', () => {
		for (const item of items) include(item, all.checked);
		update();
	});
	sync.addEventListener('click', () => {
		if (!sync.disabled) actions.sync.run(checkable ? keys.filter(key => excluded.has(key)) : []);
	});
	const contextMenu = (key: string) => {
		const targets = rows.contextTargets(key).map(target => byKey.get(target)!);
		const item = byKey.get(key)!;
		const menu = new Menu();
		// A plugin row stands for several files, so it has no single file to open.
		const fileActions = item.plugin ? [] : actions.fileActions?.(item.path) ?? [];
		for (const action of fileActions) menu.addItem(item => item.setTitle(action.title).setIcon(action.icon).onClick(() => {
			void action.run().catch((error: unknown) => new Notice(error instanceof Error ? error.message : 'Could not open this file.'));
		}));
		if (fileActions.length) menu.addSeparator();
		if (targets.length) menu.addItem(item => item
			.setTitle(`Discard ${targets.length} item${targets.length === 1 ? '' : 's'}…`)
			.setIcon('undo-2').setDisabled(locked()).onClick(() => actions.discard(targets.flatMap(target => target.keys))));
		return menu;
	};
	update();
	return {
		/** Whether rows carry checkboxes that Space toggles. */
		checkable,
		setProgress: (next?: { label: string; fraction?: number }) => { progress = next; update(); },
		update,
		toggleChecked: (key: string) => { checkboxes.get(key)?.click(); },
		removeRow: (key: string) => { checkboxes.delete(key); },
		addCheckbox: (row: HTMLElement, item: PendingItem) => {
			if (!checkable) return;
			const label = row.createEl('label', { cls: 'crate-browser-file-check' });
			const input = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': `Sync ${item.path}` } });
			checkboxes.set(item.key, input); input.checked = included(item);
			input.addEventListener('change', () => { include(item, input.checked); update(); });
		},
		// Touch hosts have no reliable context menu, so each row gets a visible menu button.
		addMenuButton: (row: HTMLElement, key: string) => {
			if (!Platform.isMobile) return;
			const button = row.createEl('button', { cls: 'crate-browser-file-menu', attr: { type: 'button', 'aria-label': `More actions for ${byKey.get(key)!.path}`, 'aria-haspopup': 'menu' } });
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
