import { Menu, Notice, Platform, setIcon } from 'obsidian';
import { decodePendingChange } from '../../sync/pending/pending-change';
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
	const selectAll = heading.createEl('label', { cls: 'crate-browser-select-all', attr: { title: 'Choose files to sync with the button below. Sync vault also includes unchecked files.' } });
	const all = selectAll.createEl('input', { attr: { type: 'checkbox', 'aria-label': 'Select all files for sync' } });
	selectAll.createSpan({ text: 'Select all' });
	heading.prepend(selectAll);
	const count = heading.createSpan({ cls: 'crate-browser-selection-count', attr: { role: 'status' } });
	const footer = sidebar.createDiv({ cls: 'crate-browser-actions' });
	const sync = footer.createEl('button', { cls: 'crate-browser-sync', attr: { type: 'button' } });
	const syncLabel = sync.createSpan({ text: 'Sync files' });
	const status = footer.createDiv({ cls: 'crate-browser-action-status', attr: { role: 'status', 'aria-live': 'polite' } });
	const checkboxes = new Map<string, HTMLInputElement>();
	let busy = false;
	// A running sync, from this button or Sync vault, locks the selection and shows its progress here.
	let progress: { label: string; fraction?: number } | undefined;
	const locked = () => busy || !!progress;
	const checked = () => keys.filter(key => !excluded.has(key));
	const update = () => {
		const selected = checked();
		all.checked = selected.length === keys.length;
		all.indeterminate = selected.length > 0 && selected.length < keys.length;
		all.disabled = locked();
		for (const [key, input] of checkboxes) { input.checked = !excluded.has(key); input.disabled = locked(); }
		count.textContent = `${selected.length} of ${keys.length} files selected`;
		const label = progress ? progress.label : busy ? 'Syncing…' : selected.length ? `Sync ${selected.length} ${selected.length === 1 ? 'file' : 'files'}` : 'Sync files';
		syncLabel.textContent = label;
		sync.setAttribute('aria-label', label);
		sync.disabled = locked() || selected.length === 0;
		sync.toggleClass('is-syncing', locked());
		sync.setCssProps({ '--crate-sync-progress': progress?.fraction === undefined ? '0' : String(progress.fraction) });
	};
	all.addEventListener('change', () => {
		for (const key of keys) { if (all.checked) excluded.delete(key); else excluded.add(key); }
		update();
	});
	sync.addEventListener('click', () => {
		if (locked() || !checked().length) return;
		const selected = checked();
		busy = true; status.textContent = ''; update();
		void actions.syncSelected(selected).catch((error: unknown) => {
			status.textContent = error instanceof Error ? error.message : 'Could not sync the selected files.';
		}).finally(() => { busy = false; update(); });
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
