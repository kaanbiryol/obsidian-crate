import { setIcon } from 'obsidian';
import type { PendingDiff } from '../../sync/pending/pending-diff';
import { renderDiffPreview } from './pending-diff';
import { CRATE_UPDATE_FILES } from '../../plugin/crate-update-bundle';

export const crateUpdateTitle = (version: string) => `Crate ${version} update`;

interface PendingDetailRequest {
	path: string;
	deleted: boolean;
	/** Set for a Crate update bundle, which is described rather than compared. */
	updateVersion: string | null;
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

	back.addEventListener('click', showFiles);
	detail.addEventListener('keydown', event => {
		if (event.key === 'Escape' && back.getClientRects().length > 0) {
			event.preventDefault();
			event.stopPropagation();
			showFiles();
		}
	});

	let requestRevision = 0;
	const show = async ({ path, deleted, updateVersion, moveFocus, read, failed, retry }: PendingDetailRequest) => {
		const parts = path.split('/');
		fileName.textContent = updateVersion ? crateUpdateTitle(updateVersion) : parts.pop() ?? path;
		filePath.textContent = updateVersion ? 'Plugin update' : parts.join('/') || 'Vault root';
		filePath.title = path;
		toolbar.hidden = false;
		comparisonHeader.empty();
		preview.empty();
		if (updateVersion) {
			++requestRevision;
			renderCrateUpdate(preview, updateVersion, deleted);
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

/** A bundle holds a whole release, so it is described rather than diffed. */
function renderCrateUpdate(preview: HTMLElement, version: string, deleted: boolean): void {
	const message = preview.createDiv({ cls: 'crate-diff-message', attr: { role: 'status' } });
	if (deleted) {
		message.createDiv({ text: `Removes the Crate ${version} update. A newer version replaced it, so no device installs it.` });
		return;
	}
	message.createDiv({ text: `Your other devices install Crate ${version} on their next sync. Crate's settings and sync state stay on each device.` });
	const files = message.createEl('ul');
	for (const name of CRATE_UPDATE_FILES) files.createEl('li', { text: name });
}
