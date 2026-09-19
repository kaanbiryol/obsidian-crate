import { Notice, Platform, setIcon, type App } from 'obsidian';
import { SharedModal } from './shared/SharedModal';
import type { FileVersionsPage, RemoteFileVersion } from '../protocol/sync-types';
import type { SyncRuntime } from '../sync/runtime';
import type { FileHistoryPreview } from '../sync/file-history-preview';
import { buildDiff, type DiffLine } from './activity/diff-model';
import { renderDiffLines } from './activity/diff-renderer';
import { openConfirmationModal } from './confirmation-modal';

export type FileHistoryRuntime = Pick<SyncRuntime, 'listRecentFileVersions' | 'getPendingRestores' | 'loadFileHistoryPreview' | 'restoreRecentFileVersion' | 'loadCurrentSyncedPreview'>;

function formatSize(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
function versionDate(value: string): Date { return new Date(value.includes(' ') ? `${value.replace(' ', 'T')}Z` : value); }
function formatDate(date: Date, seconds = false): string {
	return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' as const } : {}) }).format(date);
}
function action(container: HTMLElement, text: string, run: () => void, cls = ''): HTMLButtonElement {
	const button = container.createEl('button', { text, cls, attr: { type: 'button' } });
	button.addEventListener('click', run);
	return button;
}
/** Keep internal IDs intact for copying and comparison, but visually secondary. */
function renderFileText(container: HTMLElement, text: string, words?: DiffLine['words']): void {
	const markers = [...text.matchAll(/<!--\s*crate-id:[^\r\n]*?-->/g)].map(match => ({ start: match.index, end: match.index + match[0].length }));
	let offset = 0;
	const changes = (words ?? []).flatMap(word => {
		const start = offset; offset += word.text.length;
		return word.changed ? [{ start, end: offset }] : [];
	});
	const boundaries = [...new Set([0, text.length, ...[...markers, ...changes].flatMap(range => [range.start, range.end])])].sort((a, b) => a - b);
	for (let i = 0; i < boundaries.length - 1; i++) {
		const start = boundaries[i]!, end = boundaries[i + 1]!;
		const cls = [
			markers.some(range => start >= range.start && start < range.end) ? 'crate-history-internal-marker' : '',
			changes.some(range => start >= range.start && start < range.end) ? 'crate-diff-word' : '',
		].filter(Boolean).join(' ');
		container.createSpan({ cls, text: text.slice(start, end) });
	}
}
function filePreview(container: HTMLElement, text: string, label: string): void {
	const pre = container.createEl('pre', { attr: { tabindex: '0', 'aria-label': label } });
	renderFileText(pre, text || '(Empty file)');
}

class RemoteRecoveryModal extends SharedModal {
	private closed = false;
	private cancelInitialFocus?: () => void;
	private previewRevision = 0;
	private fileVersions: RemoteFileVersion[] = [];
	private filePage?: FileVersionsPage;
	private fileRequestRevision = 0;
	private fileLoading = false;
	private fileError?: string;
	private fileRetryCursor?: string;
	private selectedVersion?: RemoteFileVersion;
	private busy = false;
	private listEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private workspaceEl!: HTMLElement;

	constructor(app: App, private readonly runtime: FileHistoryRuntime, private readonly selectedPath: string, private readonly onBack?: () => void) { super(app); }

	onOpen(): void {
		this.closed = false;
		this.openLayout('File history');
		this.modalEl.addClass('crate-file-history-modal');
		this.modalEl.toggleClass('is-mobile', Platform.isMobile);
		this.bodyEl.addClass('crate-file-history');
		if (this.onBack) action(this.bodyEl, '← Sync activity', () => {
			this.close();
			this.onBack?.();
		}, 'crate-history-activity-back');
		const context = this.bodyEl.createDiv({ cls: 'crate-history-file-context' });
		context.createEl('h3', { text: this.selectedPath });
		context.createEl('p', { cls: 'crate-history-description', text: 'Versions are kept for 30 days.' });
		this.workspaceEl = this.bodyEl.createDiv({ cls: 'crate-history-workspace' });
		this.listEl = this.workspaceEl.createEl('nav', { cls: 'crate-history-list-pane', attr: { 'aria-label': 'File versions' } });
		this.previewEl = this.workspaceEl.createEl('section', { cls: 'crate-history-preview-pane', attr: { 'aria-label': 'File preview' } });
		void this.loadFileVersions();
		void this.selectCurrent(this.selectedPath);
		this.showPane('list');
		const title = this.contentEl.querySelector<HTMLElement>('.reminder-modal-header-title');
		const view = title?.ownerDocument.defaultView;
		if (title && view) {
			title.tabIndex = -1;
			title.focus({ preventScroll: true });
			// Obsidian may focus the first button after onOpen returns.
			const frame = view.requestAnimationFrame(() => {
				if (!this.closed && title.ownerDocument.activeElement?.classList.contains('reminder-modal-header-close')) {
					title.focus({ preventScroll: true });
				}
			});
			this.cancelInitialFocus = () => view.cancelAnimationFrame(frame);
		}
	}

	onClose(): void { this.cancelInitialFocus?.(); this.cancelInitialFocus = undefined; this.closed = true; ++this.previewRevision; ++this.fileRequestRevision; super.onClose(); }
	private showPane(pane: 'list' | 'preview'): void { this.workspaceEl.setAttribute('data-pane', pane); }
	private versionButton(container: HTMLElement, version: RemoteFileVersion, seconds: boolean): HTMLButtonElement {
		const button = action(container, '', () => { void this.selectVersion(version); }, 'crate-history-version');
		button.disabled = this.busy; button.setAttribute('data-version-key', version.storage_key);
		button.setAttribute('aria-current', String(version.storage_key === this.selectedVersion?.storage_key));
		{
			button.createSpan({ cls: 'crate-history-file-name', text: formatDate(versionDate(version.created_at), seconds), attr: { title: versionDate(version.created_at).toLocaleString() } });
			button.createSpan({ cls: 'crate-history-file-folder', text: `${version.reason === 'deleted' ? 'Before deletion' : 'Before update'} · ${formatSize(version.size)}` });
		}
		if (this.isPending(version)) button.createSpan({ cls: 'crate-history-file-folder', text: 'Restore needs to finish' });
		return button;
	}

	private async loadFileVersions(cursor?: string): Promise<void> {
		const path = this.selectedPath;
		const revision = ++this.fileRequestRevision;
		this.fileLoading = true; this.fileError = undefined; this.fileRetryCursor = cursor; this.renderVersions();
		try {
			const page = await this.runtime.listRecentFileVersions({ path, cursor });
			if (this.closed || revision !== this.fileRequestRevision) return;
			this.fileVersions = [...new Map([...(cursor ? this.fileVersions : []), ...page.versions].map(row => [row.storage_key, row])).values()]; this.filePage = page;
		} catch (error) {
			if (this.closed || revision !== this.fileRequestRevision) return;
			this.fileError = error instanceof Error ? error.message : String(error);
		} finally {
			if (!this.closed && revision === this.fileRequestRevision) { this.fileLoading = false; this.renderVersions(); }
		}
	}

	private versionRows(): RemoteFileVersion[] {
		return [...new Map([...this.fileVersions, ...this.runtime.getPendingRestores()].map(row => [row.storage_key, row])).values()].filter(row => row.path === this.selectedPath).sort((a, b) => b.created_at.localeCompare(a.created_at));
	}

	private formatHistoryDate(date: Date): string {
		const dates = this.versionRows().map(row => versionDate(row.created_at));
		const local = this.app.vault.getFileByPath(this.selectedPath);
		if (local) dates.push(new Date(local.stat.mtime));
		return formatDate(date, dates.filter(value => Math.floor(value.getTime() / 60_000) === Math.floor(date.getTime() / 60_000)).length > 1);
	}

	private renderVersions(): void {
		const focused = this.listEl.querySelector<HTMLButtonElement>('.crate-history-version:focus')?.getAttribute('data-version-key');
		this.listEl.empty();
		this.listEl.createEl('h4', { cls: 'crate-history-group', text: 'Versions' });
		const rows = this.versionRows();
		const dates = rows.map(row => versionDate(row.created_at));
		const local = this.app.vault.getFileByPath(this.selectedPath);
		if (local) dates.push(new Date(local.stat.mtime));
		const needsSeconds = (date: Date) => dates.filter(value => Math.floor(value.getTime() / 60_000) === Math.floor(date.getTime() / 60_000)).length > 1;
		const current = action(this.listEl, '', () => { void this.selectCurrent(this.selectedPath); }, 'crate-history-version crate-history-current');
		current.setAttribute('data-version-key', 'current');
		current.setAttribute('aria-label', local ? 'Current local file' : 'Current synced version');
		current.createSpan({ cls: 'crate-history-file-name', text: local ? formatDate(new Date(local.stat.mtime), needsSeconds(new Date(local.stat.mtime))) : 'Synced version', attr: local ? { title: new Date(local.stat.mtime).toLocaleString() } : {} });
		const currentMeta = current.createSpan({ cls: 'crate-history-file-folder' });
		currentMeta.createSpan({ cls: 'crate-history-current-label', text: 'Current' });
		if (local) currentMeta.createSpan({ text: ` · ${formatSize(local.stat.size)}` });
		current.disabled = this.busy; current.setAttribute('aria-current', String(!this.selectedVersion));
		if (focused === 'current') current.focus();

		for (const version of rows) { const button = this.versionButton(this.listEl, version, needsSeconds(versionDate(version.created_at))); if (focused === version.storage_key) button.focus(); }
		if (this.fileLoading) this.listEl.createEl('p', { text: 'Loading version history…', attr: { role: 'status' } });
		else if (this.fileError) {
			this.listEl.createEl('p', { text: this.fileError, attr: { role: 'alert' } });
			action(this.listEl, 'Retry versions', () => { void this.loadFileVersions(this.fileRetryCursor); }).disabled = this.busy;
		} else if (this.filePage?.hasMore) action(this.listEl, 'Older versions', () => { void this.loadFileVersions(this.filePage?.nextCursor); }).disabled = this.busy;
		else if (!rows.length) this.listEl.createEl('p', { text: 'No earlier versions retained for this file.' });
	}

	private previewHeader(title: string, caption: string): HTMLElement {
		this.previewEl.empty(); this.showPane('preview');
		action(this.previewEl, '← Versions', () => {
			this.showPane('list'); this.listEl.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
		}, 'crate-history-back');
		const header = this.previewEl.createDiv({ cls: 'crate-history-preview-header' });
		header.createEl('h3', { text: title, attr: { tabindex: '-1' } }).focus();
		header.createEl('p', { cls: 'crate-file-history-count', text: caption });
		return header;
	}

	private async selectCurrent(path: string): Promise<void> {
		if (this.busy) return;
		this.selectedVersion = undefined; const revision = ++this.previewRevision; this.renderVersions();
		const local = this.app.vault.getFileByPath(path);
		if (local) {
			this.previewHeader(this.formatHistoryDate(new Date(local.stat.mtime)), `Current local file · ${formatSize(local.stat.size)}`).setAttribute('title', new Date(local.stat.mtime).toLocaleString());
			const content = this.previewEl.createDiv({ cls: 'crate-history-preview-output' });
			if (local.stat.size > 256_000 || local.extension !== 'md') { content.createEl('p', { text: 'Preview is available for Markdown files up to 250 KiB. Select a saved version to compare or restore it.' }); return; }
			try {
				const text = await this.app.vault.cachedRead(local);
				if (!this.closed && revision === this.previewRevision) filePreview(content, text, 'Current local file contents');
			} catch { if (!this.closed && revision === this.previewRevision) content.createEl('p', { text: 'Could not read the local file.' }); }
			return;
		}
		const header = this.previewHeader('Current synced version', 'Synced file');
		header.createEl('p', { cls: 'crate-history-hint', text: 'Local edits may differ' });
		const content = this.previewEl.createDiv({ cls: 'crate-history-preview-output' });
		content.createEl('p', { text: 'Loading current synced file…', attr: { role: 'status' } });
		try {
			const snapshot = await this.runtime.loadCurrentSyncedPreview(path);
			if (this.closed || revision !== this.previewRevision) return;
			content.empty(); header.createEl('p', { cls: 'crate-file-history-count', text: `${formatDate(versionDate(snapshot.file.modified))} · ${formatSize(snapshot.file.size)}` });
			if (snapshot.unavailable) content.createEl('p', { text: snapshot.unavailable });
			else filePreview(content, snapshot.text ?? '', 'Current synced file contents');
		} catch (error) {
			if (this.closed || revision !== this.previewRevision) return;
			content.empty(); content.createEl('p', { text: error instanceof Error ? error.message : String(error), attr: { role: 'alert' } });
			action(content, 'Reload current file', () => { void this.selectCurrent(path); });
		}
	}

	private async selectVersion(version: RemoteFileVersion): Promise<void> {
		if (this.busy) return;
		this.selectedVersion = version; const revision = ++this.previewRevision; this.renderVersions();
		const header = this.previewHeader(this.formatHistoryDate(versionDate(version.created_at)), `${version.reason === 'deleted' ? 'Before deletion' : 'Before update'} · ${formatSize(version.size)}`);
		header.setAttribute('title', versionDate(version.created_at).toLocaleString());
		const actions = header.createDiv({ cls: 'crate-history-version-actions' });
		const restore = action(actions, this.isPending(version) ? 'Resume restore' : 'Restore this version', () => { void this.restore(version, restore, restoreLabel); }, 'crate-history-restore reminder-modal-header-action is-enabled');
		const restoreText = restore.textContent ?? '';
		restore.empty();
		const restoreLabel = restore.createSpan({ cls: 'reminder-modal-header-action-label', text: restoreText });
		restore.focus();
		const content = this.previewEl.createDiv({ cls: 'crate-history-preview-content' });
		content.createEl('p', { text: 'Loading preview…', attr: { role: 'status' } });
		try {
			const snapshot = await this.runtime.loadFileHistoryPreview(version);
			if (this.closed || revision !== this.previewRevision) return;
			content.empty(); this.renderPreview(content, snapshot);
		} catch (error) {
			if (this.closed || revision !== this.previewRevision) return;
			content.empty(); content.createEl('p', { text: `Preview unavailable: ${error instanceof Error ? error.message : String(error)}`, attr: { role: 'alert' } });
			content.createEl('p', { text: 'If the server is older, update it to enable previews. Restoring does not require a preview.' });
			action(content, 'Retry preview', () => { void this.selectVersion(version); });
		}
	}

	private renderPreview(container: HTMLElement, snapshot: FileHistoryPreview): void {
		if (snapshot.unavailable) { container.createEl('p', { text: snapshot.unavailable }); return; }
		const output = container.createDiv({ cls: 'crate-history-preview-output' });
		const showSaved = () => filePreview(output, snapshot.saved ?? '', 'Saved file contents');
		if (snapshot.comparisonUnavailable) {
			output.createEl('p', { text: snapshot.comparisonUnavailable });
			showSaved(); return;
		}
		const comparison = output.createDiv({ cls: 'crate-history-comparison' });
		comparison.createSpan({ text: snapshot.localMissing ? 'Missing on this device · showing saved contents' : 'Compared with current file' });
		const result = buildDiff(snapshot.current ?? '', snapshot.saved ?? '');
		if (result.limited) {
			output.createEl('p', { text: 'This comparison is too large to display. Showing the saved version.' });
			showSaved(); return;
		}
		if (!result.added && !result.removed) {
			const state = output.createDiv({ cls: 'crate-history-no-diff', attr: { role: 'status' } });
			const icon = state.createSpan({ cls: 'crate-history-state-icon', attr: { 'aria-hidden': 'true' } });
			setIcon(icon, 'check');
			const copy = state.createDiv();
			copy.createEl('p', { cls: 'crate-history-state-title', text: 'No differences' });
			copy.createEl('p', { text: 'This version matches the current local file.' });
			const details = output.createEl('details', { cls: 'crate-history-content-disclosure' });
			details.createEl('summary', { text: 'View file contents' });
			filePreview(details, snapshot.saved ?? '', 'Saved file contents');
			return;
		}
		const stats = comparison.createSpan({ cls: 'crate-history-diff-summary', attr: { 'aria-label': `${result.added} added lines, ${result.removed} removed lines` } });
		stats.createSpan({ cls: 'is-added', text: `+${result.added}` });
		stats.createSpan({ cls: 'is-removed', text: `−${result.removed}` });
		output.addClass('crate-file-diff', 'crate-history-diff');
		renderDiffLines(output, result.lines, 'Changes from current local file to saved version', (container, line) => renderFileText(container, line.text || ' ', line.words));
	}

	private isPending(version: RemoteFileVersion): boolean { return this.runtime.getPendingRestores().some(row => row.storage_key === version.storage_key); }

	private async restore(version: RemoteFileVersion, button: HTMLButtonElement, label: HTMLElement): Promise<void> {
		if (this.busy) return;
		this.busy = true; button.disabled = true; button.toggleClass('is-enabled', false); this.renderVersions();
		try {
			const confirmed = this.isPending(version) || await openConfirmationModal(this.app, {
				title: 'Restore file version', message: `Restore ${version.path} from ${versionDate(version.created_at).toLocaleString()}?`,
				details: ['This restores the remote file and syncs it to this device. Local edits follow normal sync conflict handling.', 'The current remote version, if any, remains recoverable for 30 days.'], confirmText: 'Restore',
			});
			if (!confirmed || this.closed) return;
			label.setText('Restoring…');
			const result = await this.runtime.restoreRecentFileVersion(version);
			if (!result.success) { new Notice(`Restore confirmed remotely. Local sync is incomplete: ${result.errors[0] || 'Retry sync'}. Resume the saved restore to finish safely.`); return; }
			new Notice(`Restored ${version.path}. Current remote changes synced.`);
			if (!this.closed) { label.setText('Restored'); await this.loadFileVersions(); }
		} catch (error) { new Notice(`Restore incomplete: ${error instanceof Error ? error.message : String(error)}`); }
		finally {
			this.busy = false;
			if (!this.closed) { button.disabled = false; button.toggleClass('is-enabled', true); label.setText(this.isPending(version) ? 'Resume restore' : 'Restore this version'); this.renderVersions(); }
		}
	}
}

export function openRemoteRecoveryModal(app: App, runtime: FileHistoryRuntime, path: string, onBack?: () => void): void {
	new RemoteRecoveryModal(app, runtime, path, onBack).open();
}
