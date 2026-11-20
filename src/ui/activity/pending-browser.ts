import { Notice, setIcon } from 'obsidian';
import type { PendingDiff } from '../../sync/pending/pending-diff';
import { isBinaryPreviewPath } from '../../sync/history/preview-format';
import { countDiff } from './diff-model';
import { createPendingDetail } from './pending-detail';
import { PendingComparisons } from './pending-comparisons';
import { createPendingActions, type PendingActions } from './pending-actions';
import { createPendingRowSelection, type PendingRowSelectionState } from './pending-row-selection';
import { groupPendingItems, pendingPluginStatus, type PendingItem, type PluginNameReader } from './pending-items';

/** `localOnly` skips fetching a last-synced copy that is not cached on this device. */
export type PendingDiffLoader = (path: string, deleted: boolean, options?: { localOnly?: boolean }) => Promise<PendingDiff>;
export interface PendingBrowserState extends PendingRowSelectionState {
	selectedKey?: string;
	/** The vault's config folder, so plugin files and Crate update bundles show as plugin rows. */
	configDir?: string;
	readPluginName?: PluginNameReader;
	/** Plugin names by folder, read once per open activity view. */
	pluginNames?: Map<string, Promise<string | undefined>>;
	excludedKeys?: Set<string>;
	/** Finished file statuses by pending key, so a rebuild checks only files it has not checked. */
	statusLabels?: Map<string, string>;
	showDetail?: boolean;
	scrollTop?: number;
}

/** The rendered browser's file checks. Its owner pauses them while the list is hidden
 * and disposes them before a rebuild renders a new browser. */
export interface PendingChecks {
	start(): void;
	pause(): void;
	dispose(): void;
	/** Locks the list and shows sync progress in its footer; no argument clears it. */
	setSyncProgress(progress?: { label: string; fraction?: number }): void;
	/** Shows the sync button's current state, such as Stopping… after Stop sync. */
	updateAction(): void;
}

let nextBrowserId = 0;
/** Each check reads and hashes a file without Worker requests; longer lists check on selection. */
const MAX_AUTO_CHECKED_FILES = 200;
/** A first sync can list every vault file, so only rows near the viewport exist.
 * Rows are one line high; the first two rendered rows measure the real pitch. */
const ESTIMATED_ROW_PX = 48;
const OVERSCAN_ROWS = 10;
/** Rows to render while the list has no size yet, such as on a hidden tab. */
const UNSIZED_ROWS = 40;

/** Rows to render, `start` inclusive and `end` exclusive: those in view plus overscan on
 * each side. A list with no size yet renders a fixed number of rows. */
export function pendingRowWindow(scrollTop: number, viewport: number, rowPx: number, count: number): { start: number; end: number } {
	const first = Math.floor(scrollTop / rowPx);
	return {
		start: Math.max(0, first - OVERSCAN_ROWS),
		end: Math.min(count, first + (viewport > 0 ? Math.ceil(viewport / rowPx) : UNSIZED_ROWS) + OVERSCAN_ROWS),
	};
}

/** Check file statuses on opening, or on selection in long lists; keep one selected comparison in view. */
export function renderPendingBrowser(container: HTMLElement, pendingKeys: string[], load: PendingDiffLoader, state: PendingBrowserState = {}, actions?: PendingActions): PendingChecks {
	const items = groupPendingItems(pendingKeys, state.configDir);
	// Rows are keyed by item: a plugin row covers several pending keys.
	const paths = items.map(item => item.key);
	const browser = container.createDiv({ cls: 'crate-pending-browser' });
	const sidebar = browser.createDiv({ cls: 'crate-browser-sidebar' });
	const heading = sidebar.createDiv({ cls: 'crate-browser-list-heading' });
	if (!actions) heading.createSpan({ text: 'Files' });
	const list = sidebar.createEl('nav', { cls: 'crate-browser-files', attr: { 'aria-label': 'Pending files' } });
	const listHint = sidebar.createDiv({ cls: 'crate-browser-list-hint', text: actions?.automaticSync ? 'These files upload on the next automatic sync. Command or Control+A highlights all files. Shift-click selects a range; Command or Control-click selects individual files. Right-click or press Shift+F10 for actions on highlighted files.' : actions ? 'Checkboxes choose which files the button below the list uploads. It also gets changes from your other devices. Unchecked files stay on this device until you sync them. Space toggles the focused checkbox. Command or Control+A highlights all files. Shift-click selects a range; Command or Control-click selects individual files. Right-click or press Shift+F10 for actions on highlighted files.' : 'Review changes since the last sync.' });
	listHint.id = `crate-pending-hint-${++nextBrowserId}`;
	list.setAttribute('aria-describedby', listHint.id);

	const rowSelection = createPendingRowSelection(sidebar, paths, state);
	const selection = actions ? createPendingActions(sidebar, heading, items, state.excludedKeys ??= new Set(), actions, rowSelection) : undefined;

	let selectedIndex = -1;
	const detail = createPendingDetail(browser, `crate-pending-detail-${nextBrowserId}`, () => {
		state.showDetail = false;
		browser.classList.remove('is-reviewing');
		focusRow(selectedIndex);
	});

	// Plugin rows are described rather than compared. Binary files have no text diff; load their metadata only when selected.
	const isPlugin = (item: PendingItem) => !!item.plugin || !!item.crateUpdate;
	const canPreview = (index: number) => !isPlugin(items[index]!) && !isBinaryPreviewPath(items[index]!.path);
	const names = state.pluginNames ??= new Map<string, Promise<string | undefined>>();
	const resolvedNames = new Map<string, string>();
	const pluginName = (item: PendingItem) => item.crateUpdate ? 'Crate' : item.plugin ? resolvedNames.get(item.plugin.folder) ?? item.plugin.folder : '';
	const labels = state.statusLabels ??= new Map<string, string>();
	// A file that left the pending set may return with other changes.
	const pending = new Set(paths);
	for (const key of labels.keys()) if (!pending.has(key)) labels.delete(key);
	const needsCheck = (index: number) => canPreview(index) && !labels.has(paths[index]!);
	const autoCheck = paths.filter((_, index) => needsCheck(index)).length <= MAX_AUTO_CHECKED_FILES;
	// Rendered rows by index. Selection, checkboxes and statuses live in state, so
	// a row can be dropped and rebuilt as it scrolls out of and into view.
	const rows = new Map<number, { element: HTMLElement; button: HTMLButtonElement; status: HTMLSpanElement }>();
	const rowIndexes = new WeakMap<Element, number>();
	const unavailable = new Set<number>();
	const showStatus = (status: HTMLSpanElement, text: string) => {
		status.textContent = text;
		status.title = text;
		status.classList.toggle('is-unchanged', text === 'Unchanged');
	};
	const comparisons = new PendingComparisons(paths.length, (index, localOnly) => {
		const { deleted, path } = items[index]!;
		return load(path, deleted, { localOnly });
	}, (index, snapshot) => {
		const label = describeSnapshot(snapshot);
		labels.set(paths[index]!, label);
		const row = rows.get(index);
		if (browser.isConnected && row) showStatus(row.status, label);
	}, index => {
		unavailable.add(index);
		const row = rows.get(index);
		if (browser.isConnected && row) row.status.textContent = 'Unavailable';
	}, index => autoCheck && needsCheck(index));
	const select = async (index: number, moveFocus = true) => {
		const key = paths[index];
		if (!key) return;
		selectedIndex = index;
		state.selectedKey = key;
		if (moveFocus) state.showDetail = true;
		browser.classList.toggle('is-reviewing', !!state.showDetail);
		setFocusIndex(index);
		const item = items[index]!;
		await detail.show({
			path: item.path, deleted: item.deleted, moveFocus,
			plugin: isPlugin(item) ? { name: pluginName(item), crateUpdate: !!item.crateUpdate, keys: item.keys } : null,
			read: () => comparisons.read(index),
			failed: () => {
				unavailable.add(index);
				const row = rows.get(index);
				if (row) row.status.textContent = 'Unavailable';
			},
			retry: () => { void select(index, false); },
		});
	};

	const before = list.createDiv({ attr: { 'aria-hidden': 'true' } });
	const after = list.createDiv({ attr: { 'aria-hidden': 'true' } });
	let rowPx = ESTIMATED_ROW_PX, measured = false;
	let focusIndex = 0;
	const mountRow = (index: number) => {
		const key = paths[index]!;
		const item = items[index]!;
		const { deleted, path } = item;
		const parts = path.split('/');
		const plugin = isPlugin(item);
		const row = actions ? list.createDiv({ cls: 'crate-browser-file-row' }) : list;
		selection?.addCheckbox(row, item);
		selection?.bindContextMenu(row, key);
		const button = row.createEl('button', { cls: 'crate-browser-file', attr: {
			type: 'button', 'aria-label': plugin ? `Review ${pluginName(item)}, ${pendingPluginStatus(item).toLowerCase()}` : `${deleted ? 'Review deletion of' : 'Review changes for'} ${path}`,
			'aria-pressed': 'false', 'aria-controls': detail.id,
		} });
		button.tabIndex = index === focusIndex ? 0 : -1;
		if (selection?.checkable) button.setAttribute('aria-keyshortcuts', 'Space');
		if (!actions) setIcon(button.createSpan({ cls: 'crate-browser-file-icon', attr: { 'aria-hidden': 'true' } }), deleted ? 'trash-2' : plugin ? 'package' : 'file-text');
		const info = button.createSpan({ cls: 'crate-browser-file-info' });
		const name = info.createSpan({ cls: 'crate-browser-file-name', text: plugin ? pluginName(item) : parts.pop() ?? path, attr: { title: path } });
		const meta = info.createSpan({ cls: 'crate-browser-file-meta' });
		meta.createSpan({ cls: 'crate-browser-file-path', text: plugin ? pendingPluginStatus(item) : parts.join('/') || 'Vault root' });
		const status = meta.createSpan({ cls: 'crate-browser-file-status', text: plugin ? ''
			: !canPreview(index) ? 'No preview' : autoCheck ? 'Checking…' : 'Not checked' });
		if (item.plugin) void readName(item.plugin.folder, index, name);
		const label = labels.get(key);
		if (unavailable.has(index)) status.textContent = 'Unavailable';
		else if (label) showStatus(status, label);
		status.id = `${detail.id}-status-${index}`;
		button.setAttribute('aria-describedby', status.id);
		selection?.addMenuButton(row, key);
		rowSelection.addButton(key, button);
		rowIndexes.set(button, index);
		button.addEventListener('click', event => {
			rowSelection.choose(index, event);
			void select(index, !event.shiftKey && !event.metaKey && !event.ctrlKey);
		});
		button.addEventListener('dblclick', () => {
			const action = plugin ? undefined : actions?.fileActions?.(path).find(action => action.id === 'open');
			if (action) void action.run().catch((error: unknown) => {
				new Notice(error instanceof Error ? error.message : 'Could not open this file.');
			});
		});
		button.addEventListener('keyup', event => {
			if (selection?.checkable && event.key === ' ') event.preventDefault();
		});
		const entry = { element: actions ? row : button, button, status };
		rows.set(index, entry);
		return entry;
	};
	// A plugin row shows its folder until its manifest name is read, then its name.
	const readName = async (folder: string, index: number, element: HTMLElement) => {
		if (!state.readPluginName) return;
		let read = names.get(folder);
		if (!read) {
			read = state.readPluginName(folder).catch(() => undefined);
			names.set(folder, read);
		}
		const value = await read;
		// A row mounted after the name was read already shows it.
		if (!value || !browser.isConnected || resolvedNames.get(folder) === value) return;
		resolvedNames.set(folder, value);
		if (element.isConnected) {
			element.textContent = value;
			rows.get(index)?.button.setAttribute('aria-label', `Review ${value}, ${pendingPluginStatus(items[index]!).toLowerCase()}`);
		}
		if (selectedIndex === index) void select(index, false);
	};
	const unmountRow = (index: number) => {
		const row = rows.get(index)!;
		// Keep keyboard focus in the list when its focused row scrolls away.
		if (row.element.contains(row.element.ownerDocument.activeElement)) list.focus({ preventScroll: true });
		rows.delete(index);
		rowSelection.removeButton(paths[index]!);
		selection?.removeRow(paths[index]!);
		row.element.remove();
	};
	const renderWindow = () => {
		const { start, end } = pendingRowWindow(list.scrollTop, list.clientHeight, rowPx, paths.length);
		for (const index of [...rows.keys()]) if (index < start || index >= end) unmountRow(index);
		let next: Element = after;
		for (let index = end - 1; index >= start; index--) {
			const row = rows.get(index) ?? mountRow(index);
			if (row.element.nextElementSibling !== next) list.insertBefore(row.element, next);
			next = row.element;
		}
		before.setCssProps({ height: `${start * rowPx}px` });
		after.setCssProps({ height: `${(paths.length - end) * rowPx}px` });
		// A tab stop stays reachable while the focused row is out of view.
		list.tabIndex = rows.has(focusIndex) ? -1 : 0;
		const firstRow = rows.get(start), secondRow = rows.get(start + 1);
		const pitch = !measured && firstRow && secondRow ? secondRow.element.getBoundingClientRect().top - firstRow.element.getBoundingClientRect().top : 0;
		if (pitch > 0) {
			measured = true;
			rowPx = pitch;
			renderWindow();
		}
	};
	const scrollToRow = (index: number) => {
		const top = index * rowPx;
		if (top < list.scrollTop) list.scrollTop = top;
		else if (top + rowPx > list.scrollTop + list.clientHeight) list.scrollTop = top + rowPx - list.clientHeight;
		renderWindow();
	};
	const setFocusIndex = (index: number) => {
		rows.get(focusIndex)?.button.setAttribute('tabindex', '-1');
		focusIndex = index;
		rows.get(index)?.button.setAttribute('tabindex', '0');
		list.tabIndex = rows.has(focusIndex) ? -1 : 0;
	};
	const focusRow = (index: number) => {
		if (!paths[index]) return;
		scrollToRow(index);
		rows.get(index)?.button.focus({ preventScroll: true });
	};
	// One handler covers every row and the list itself, which holds focus when its
	// focused row has scrolled out of the rendered window.
	list.addEventListener('keydown', event => {
		const target = event.target as Element;
		const button = target.closest('.crate-browser-file');
		const index = button ? rowIndexes.get(button) : target === list ? focusIndex : undefined;
		if (index === undefined) return;
		const key = paths[index]!;
		if (selection?.checkable && button && event.key === ' ') {
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
		setFocusIndex(next);
		focusRow(next);
		// Desktop previews follow arrow navigation; mobile waits for activation.
		if (browser.clientWidth > 640) void select(next, false);
	});
	list.addEventListener('scroll', () => {
		state.scrollTop = list.scrollTop;
		renderWindow();
	});
	const resize = new ResizeObserver(() => renderWindow());
	resize.observe(list);

	const previousIndex = paths.findIndex(key => key === state.selectedKey);
	focusIndex = Math.max(previousIndex, 0);
	renderWindow();
	list.scrollTop = state.scrollTop ?? 0;
	renderWindow();
	if (previousIndex >= 0) void select(previousIndex, false);
	else { state.selectedKey = undefined; state.showDetail = false; }
	queueMicrotask(() => {
		if (browser.isConnected && browser.getClientRects().length > 0) comparisons.start();
	});
	return {
		start: () => { renderWindow(); comparisons.start(); },
		pause: () => comparisons.pause(),
		dispose: () => { resize.disconnect(); comparisons.dispose(); },
		setSyncProgress: progress => {
			browser.classList.toggle('is-syncing', !!progress);
			// The list holds still while a sync runs: no taps, keys or scrolling.
			list.inert = !!progress;
			selection?.setProgress(progress);
		},
		updateAction: () => selection?.update(),
	};
}

function describeSnapshot(snapshot: PendingDiff): string {
	if (snapshot.unchanged) return 'Unchanged';
	if (snapshot.baselineUnavailable) return snapshot.kind === 'deleted' ? 'Deleted' : 'Modified';
	if (snapshot.unavailable || snapshot.before === undefined || snapshot.after === undefined) return 'No preview';
	if (snapshot.kind === 'added') return 'Added';
	if (snapshot.kind === 'deleted') return 'Deleted';
	if (snapshot.before === snapshot.after) return 'Unchanged';
	const diff = countDiff(snapshot.before, snapshot.after);
	if (diff.limited) return 'Modified';
	return `+${diff.added} −${diff.removed}`;
}
