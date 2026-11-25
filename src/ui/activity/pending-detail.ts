import { setIcon } from 'obsidian';
import type { PendingDiff } from '../../sync/pending/pending-diff';
import { renderDiffPreview } from './pending-diff';
import { renderBackButton } from './rendering';
import { CRATE_UPDATE_FILES } from '../../plugin/crate-update/bundle';
import { decodePendingChange } from '../../sync/pending/pending-change';
import { pendingPluginStatus } from './pending-items';

interface PendingDetailRequest {
	path: string;
	deleted: boolean;
	/** Set for a plugin row or Crate update bundle, which is described rather than compared. */
	plugin: { name: string; crateUpdate: boolean; keys: string[] } | null;
	/** Moves focus to the back button when the detail replaces the list. */
	moveFocus: boolean;
	read: () => Promise<PendingDiff>;
	/** The comparison could not be loaded. */
	failed: () => void;
	retry: () => void;
}

export interface PendingDetail {
	id: string;
	show(request: PendingDetailRequest): Promise<void>;
}

/** The comparison pane beside the file list. On narrow layouts it replaces the list
 * while `is-reviewing` is set; Back or Escape returns to the files. */
export function createPendingDetail(browser: HTMLElement, id: string, showFiles: () => void): PendingDetail {
	const detail = browser.createDiv({ cls: 'crate-browser-detail', attr: { role: 'region', 'aria-label': 'File comparison' } });
	detail.id = id;
	const toolbar = detail.createDiv({ cls: 'crate-browser-toolbar' });
	const back = renderBackButton(toolbar, 'crate-browser-back', 'Files', showFiles);
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

	detail.addEventListener('keydown', event => {
		if (event.key === 'Escape' && back.getClientRects().length > 0) {
			event.preventDefault();
			event.stopPropagation();
			showFiles();
		}
	});

	let requestRevision = 0;
	const show = async ({ path, deleted, plugin, moveFocus, read, failed, retry }: PendingDetailRequest) => {
		const parts = path.split('/');
		fileName.textContent = plugin ? plugin.name : parts.pop() ?? path;
		filePath.textContent = plugin ? pendingPluginStatus({ deleted, crateUpdate: plugin.crateUpdate }) : parts.join('/') || 'Vault root';
		filePath.title = path;
		toolbar.hidden = false;
		comparisonHeader.empty();
		preview.empty();
		if (plugin) {
			++requestRevision;
			renderPlugin(preview, plugin, deleted);
			if (moveFocus && back.getClientRects().length > 0) back.focus({ preventScroll: true });
			return;
		}
		preview.createDiv({ cls: 'crate-diff-message', text: 'Loading changes…', attr: { role: 'status' } });
		preview.setAttribute('aria-busy', 'true');
		if (moveFocus && back.getClientRects().length > 0) back.focus({ preventScroll: true });
		const revision = ++requestRevision;
		try {
			const snapshot = await read();
			if (!browser.isConnected || revision !== requestRevision) return;
			preview.empty();
			renderDiffPreview(preview, snapshot, path, comparisonHeader);
		} catch (error) {
			if (!browser.isConnected || revision !== requestRevision) return;
			preview.empty();
			failed();
			const message = preview.createDiv({ cls: 'crate-diff-message', attr: { role: 'status' } });
			message.createSpan({ text: error instanceof Error ? error.message : 'Could not load changes.' });
			const retryButton = message.createEl('button', { text: 'Try again', cls: 'crate-activity-action', attr: { type: 'button' } });
			retryButton.addEventListener('click', retry);
		} finally {
			if (browser.isConnected && revision === requestRevision) {
				preview.removeAttribute('aria-busy');
			}
		}
	};
	return { id, show };
}

/** A plugin's code changes together, so it is described rather than diffed file by file. */
function renderPlugin(preview: HTMLElement, plugin: NonNullable<PendingDetailRequest['plugin']>, deleted: boolean): void {
	const summary = preview.createDiv({ cls: 'crate-plugin-summary' });
	const text = (value: string) => summary.createEl('p', { cls: 'crate-plugin-summary-text', text: value });
	const files = () => summary.createEl('ul', { cls: 'crate-plugin-files' });
	const file = (list: HTMLElement, name: string, deleted = false) => {
		const item = list.createEl('li');
		setIcon(item.createSpan({ cls: 'crate-plugin-file-icon', attr: { 'aria-hidden': 'true' } }), 'file-code');
		item.createSpan({ cls: 'crate-plugin-file-name', text: name });
		if (deleted) item.createSpan({ cls: 'crate-plugin-file-deleted', text: 'Deleted' });
	};
	if (plugin.crateUpdate) {
		if (deleted) {
			text('Removes an older Crate update that a newer one replaced, so no device installs it.');
			return;
		}
		text("Your other devices install this Crate update on their next sync. Crate's settings and sync state stay on each device.");
		if (plugin.keys.some(key => decodePendingChange(key).kind === 'delete')) text('It also removes the older update it replaces, so no device installs that one.');
		const list = files();
		for (const name of CRATE_UPDATE_FILES) file(list, name);
		return;
	}
	text(deleted
		? 'Syncing removes this plugin from your other devices too.'
		: 'Your other devices get this plugin on their next sync. Its files sync together, so no device gets only part of it. Its settings sync separately.');
	const list = files();
	for (const key of plugin.keys) {
		const { kind, path } = decodePendingChange(key);
		file(list, path.slice(path.lastIndexOf('/') + 1), !deleted && kind === 'delete');
	}
}
