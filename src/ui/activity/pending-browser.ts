import { Notice, setIcon } from 'obsidian';
import type { PendingDiff } from '../../sync/pending/pending-diff';
import { isBinaryPreviewPath } from '../../sync/history/preview-format';
import { decodePendingChange } from '../../sync/pending/pending-change';
import { buildDiff } from './diff-model';
import { renderDiffPreview } from './pending-diff';
import { PendingComparisons } from './pending-comparisons';
import { createPendingActions, type PendingActions } from './pending-actions';
import { createPendingRowSelection, type PendingRowSelectionState } from './pending-row-selection';

export type PendingDiffLoader = (path: string, deleted: boolean) => Promise<PendingDiff>;
export interface PendingBrowserState extends PendingRowSelectionState {
	selectedKey?: string;
	excludedKeys?: Set<string>;
	/** Finished file statuses by pending key, so a rebuild checks only files it has not checked. */
	statusLabels?: Map<string, string>;
	showDetail?: boolean;
	scrollTop?: number;
	startChecks?: () => void;
	pauseChecks?: () => void;
	dispose?: () => void;
}

let nextBrowserId = 0;
/** Each check reads and hashes a file, plus Worker requests for some, so longer lists check on selection. */
const MAX_AUTO_CHECKED_FILES = 200;
/** A first sync can list every vault file, so only rows near the viewport exist.
 * Rows are one line high; the first two rendered rows measure the real pitch. */
const ESTIMATED_ROW_PX = 48;
const OVERSCAN_ROWS = 10;
/** Rows to render while the list has no size yet, such as on a hidden tab. */
const UNSIZED_ROWS = 40;

/** Check file statuses on opening, or on selection in long lists; keep one selected comparison in view. */
export function renderPendingBrowser(container: HTMLElement, paths: string[], load: PendingDiffLoader, state: PendingBrowserState = {}, actions?: PendingActions): void {
	const changes = paths.map(decodePendingChange);
	const browser = container.createDiv({ cls: 'crate-pending-browser' });
	const sidebar = browser.createDiv({ cls: 'crate-browser-sidebar' });
	const heading = sidebar.createDiv({ cls: 'crate-browser-list-heading' });
	if (!actions) heading.createSpan({ text: 'Files' });
	const list = sidebar.createEl('nav', { cls: 'crate-browser-files', attr: { 'aria-label': 'Pending files' } });
	const listHint = sidebar.createDiv({ cls: 'crate-browser-list-hint', text: actions ? 'Checkboxes choose which files to sync with the button below the list. Sync vault syncs all local and remote changes, including unchecked files. Space toggles the focused checkbox. Command or Control+A highlights all files. Shift-click selects a range; Command or Control-click selects individual files. Right-click or press Shift+F10 for actions on highlighted files.' : 'Review changes since the last sync.' });
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
	empty.createDiv({ text: 'Compare this device’s changes with its last-synced copy.' });

	let requestRevision = 0;
	let selectedIndex = -1;
	// Binary files have no text diff; load their metadata only when selected.
	const canPreview = (index: number) => !isBinaryPreviewPath(changes[index]!.path);
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
	const comparisons = new PendingComparisons(paths.length, index => {
		const { kind, path } = changes[index]!;
		return load(path, kind === 'delete');
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
	const showFiles = () => {
		state.showDetail = false;
		browser.classList.remove('is-reviewing');
		focusRow(selectedIndex);
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
		if (!key) return;
		selectedIndex = index;
		state.selectedKey = key;
		if (moveFocus) state.showDetail = true;
		browser.classList.toggle('is-reviewing', !!state.showDetail);
		const { path } = changes[index]!;
		const parts = path.split('/');
		fileName.textContent = parts.pop() ?? path;
		filePath.textContent = parts.join('/') || 'Vault root';
		filePath.title = path;
		toolbar.hidden = false;
		setFocusIndex(index);
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
			unavailable.add(index);
			const row = rows.get(index);
			if (row) row.status.textContent = 'Unavailable';
			const message = preview.createDiv({ cls: 'crate-diff-message', attr: { role: 'status' } });
			message.createSpan({ text: error instanceof Error ? error.message : 'Could not load changes.' });
			const retry = message.createEl('button', { text: 'Try again', cls: 'crate-activity-action', attr: { type: 'button' } });
			retry.addEventListener('click', () => { void select(index, false); });
		} finally {
			if (browser.isConnected && revision === requestRevision) {
				preview.removeAttribute('aria-busy');
			}
		}
	};

	const before = list.createDiv({ attr: { 'aria-hidden': 'true' } });
	const after = list.createDiv({ attr: { 'aria-hidden': 'true' } });
	let rowPx = ESTIMATED_ROW_PX, measured = false;
	let focusIndex = 0;
	const mountRow = (index: number) => {
		const key = paths[index]!;
		const { kind, path } = changes[index]!;
		const deleted = kind === 'delete';
		const parts = path.split('/');
		const row = actions ? list.createDiv({ cls: 'crate-browser-file-row' }) : list;
		selection?.addCheckbox(row, key);
		selection?.bindContextMenu(row, key);
		const button = row.createEl('button', { cls: 'crate-browser-file', attr: {
			type: 'button', 'aria-label': `${deleted ? 'Review deletion of' : 'Review changes for'} ${path}`,
			'aria-pressed': 'false', 'aria-controls': detail.id,
		} });
		button.tabIndex = index === focusIndex ? 0 : -1;
		if (selection) button.setAttribute('aria-keyshortcuts', 'Space');
		if (!actions) setIcon(button.createSpan({ cls: 'crate-browser-file-icon', attr: { 'aria-hidden': 'true' } }), deleted ? 'trash-2' : 'file-text');
		const info = button.createSpan({ cls: 'crate-browser-file-info' });
		info.createSpan({ cls: 'crate-browser-file-name', text: parts.pop() ?? path, attr: { title: path } });
		const meta = info.createSpan({ cls: 'crate-browser-file-meta' });
		meta.createSpan({ cls: 'crate-browser-file-path', text: parts.join('/') || 'Vault root' });
		const status = meta.createSpan({ cls: 'crate-browser-file-status', text: !canPreview(index) ? 'No preview' : autoCheck ? 'Checking…' : 'Not checked' });
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
			const action = actions?.fileActions?.(path).find(action => action.id === 'open');
			if (action) void action.run().catch((error: unknown) => {
				new Notice(error instanceof Error ? error.message : 'Could not open this file.');
			});
		});
		button.addEventListener('keyup', event => {
			if (selection && event.key === ' ') event.preventDefault();
		});
		const entry = { element: actions ? row : button, button, status };
		rows.set(index, entry);
		return entry;
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
		const viewport = list.clientHeight;
		const first = Math.floor(list.scrollTop / rowPx);
		const start = Math.max(0, first - OVERSCAN_ROWS);
		const end = Math.min(paths.length, first + (viewport > 0 ? Math.ceil(viewport / rowPx) : UNSIZED_ROWS) + OVERSCAN_ROWS);
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
		if (selection && button && event.key === ' ') {
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
	state.startChecks = () => { renderWindow(); comparisons.start(); };
	state.pauseChecks = () => comparisons.pause();
	state.dispose = () => { resize.disconnect(); comparisons.dispose(); };

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
}

function describeSnapshot(snapshot: PendingDiff): string {
	if (snapshot.unchanged) return 'Unchanged';
	if (snapshot.baselineUnavailable) return snapshot.kind === 'deleted' ? 'Deleted' : 'Modified';
	if (snapshot.unavailable || snapshot.before === undefined || snapshot.after === undefined) return 'No preview';
	if (snapshot.kind === 'added') return 'Added';
	if (snapshot.kind === 'deleted') return 'Deleted';
	if (snapshot.before === snapshot.after) return 'Unchanged';
	const diff = buildDiff(snapshot.before, snapshot.after);
	if (diff.limited) return 'Modified';
	return `+${diff.added} −${diff.removed}`;
}
