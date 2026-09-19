import { Notice, Platform, Setting, setIcon, type App } from 'obsidian';
import { SharedModal } from './shared/SharedModal';
import type { FileVersionsPage, RemoteFileVersion } from '../protocol/sync-types';
import type { SyncRuntime } from '../sync/runtime';
import type { FileHistoryPreview } from '../sync/file-history-preview';
import { buildDiff } from './activity/diff-model';
import { openConfirmationModal } from './confirmation-modal';

export type FileHistoryRuntime = Pick<SyncRuntime, 'listRecentFileVersions' | 'getPendingRestores' | 'loadFileHistoryPreview' | 'restoreRecentFileVersion' | 'listCurrentSyncedFiles' | 'loadCurrentSyncedPreview'>;

function formatSize(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
function versionDate(value: string): Date { return new Date(value.includes(' ') ? `${value.replace(' ', 'T')}Z` : value); }
function action(container: HTMLElement, text: string, run: () => void, cls = ''): HTMLButtonElement {
	const button = container.createEl('button', { text, cls, attr: { type: 'button' } });
	button.addEventListener('click', run);
	return button;
}
/** Keep internal IDs intact for copying and comparison, but visually secondary. */
function renderFileText(container: HTMLElement, text: string): void {
	const markers = /<!--\s*crate-id:[^\r\n]*?-->/g;
	let end = 0;
	for (const match of text.matchAll(markers)) {
		if (match.index > end) container.createSpan({ text: text.slice(end, match.index) });
		container.createSpan({ cls: 'crate-history-internal-marker', text: match[0] });
		end = match.index + match[0].length;
	}
	if (end < text.length) container.createSpan({ text: text.slice(end) });
}
function filePreview(container: HTMLElement, text: string, label: string): void {
	const pre = container.createEl('pre', { attr: { tabindex: '0', 'aria-label': label } });
	renderFileText(pre, text || '(Empty file)');
}

function folderOf(path: string): string { return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; }
function pathLabel(button: HTMLElement, path: string, size?: number): void {
	const separator = path.lastIndexOf('/');
	button.createSpan({ cls: 'crate-history-file-name', text: path.slice(separator + 1) });
	button.createSpan({ cls: 'crate-history-file-folder', text: `${separator < 0 ? 'Vault root' : path.slice(0, separator)}${size === undefined ? '' : ` · ${formatSize(size)}`}` });
}

class RemoteRecoveryModal extends SharedModal {
	private closed = false;
	private previewRevision = 0;
	private search = '';

	private fileLimit = 200;
	private readonly expandedFolders = new Set<string>();
	private selectedPath?: string;
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
	private toolbarEl!: HTMLElement;

	constructor(app: App, private readonly runtime: FileHistoryRuntime, private readonly initialPath?: string) { super(app); }

	onOpen(): void {
		this.closed = false;
		this.openLayout('File history');
		this.modalEl.addClass('crate-file-history-modal');
		this.modalEl.toggleClass('is-mobile', Platform.isMobile);
		this.bodyEl.addClass('crate-file-history');
		this.bodyEl.createEl('p', { cls: 'crate-history-description', text: 'Choose a file to compare or restore a saved version. Versions are kept for 30 days.' });
		let query = '';
		const search = () => {
			if (this.busy) return;
			this.search = query.trim(); this.resetSelection(); this.fileLimit = 200;
			this.load();
		};
		const toolbar = this.toolbarEl = this.bodyEl.createDiv({ cls: 'crate-history-toolbar' });
		const searchSetting = new Setting(toolbar).setClass('crate-history-search');
		const searchIcon = searchSetting.controlEl.createSpan({ cls: 'crate-history-search-icon', attr: { 'aria-hidden': 'true' } });
		setIcon(searchIcon, 'search');
		let input!: HTMLInputElement;
		searchSetting.addText(text => {
			input = text.inputEl;
			text.setPlaceholder('Search files or folders').onChange(value => { query = value; clear.hidden = !value; });
			input.setAttribute('aria-label', 'Search files or folders');
			input.setAttribute('enterkeyhint', 'search');
			input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
		});
		const clear = action(searchSetting.controlEl, '', () => {
			if (this.busy) return;
			query = ''; input.value = ''; clear.hidden = true; search(); input.focus();
		}, 'crate-history-search-clear');
		clear.setAttribute('aria-label', 'Clear search'); clear.setAttribute('title', 'Clear search');
		clear.hidden = true; setIcon(clear, 'x');
		this.workspaceEl = this.bodyEl.createDiv({ cls: 'crate-history-workspace' });
		this.listEl = this.workspaceEl.createEl('nav', { cls: 'crate-history-list-pane', attr: { 'aria-label': 'Vault files and versions' } });
		this.previewEl = this.workspaceEl.createEl('section', { cls: 'crate-history-preview-pane', attr: { 'aria-label': 'File preview' } });
		this.resetSelection();
		if (this.initialPath) this.selectFile(this.initialPath);
		else this.load();
	}

	onClose(): void { this.closed = true; ++this.previewRevision; ++this.fileRequestRevision; super.onClose(); }
	private showPane(pane: 'list' | 'preview'): void { this.workspaceEl.setAttribute('data-pane', pane); }
	private resetSelection(): void {
		this.selectedPath = undefined; this.selectedVersion = undefined;
		++this.previewRevision; ++this.fileRequestRevision;
		this.previewEl.empty();
		const empty = this.previewEl.createDiv({ cls: 'crate-history-empty' });
		const icon = empty.createSpan({ cls: 'crate-history-empty-icon', attr: { 'aria-hidden': 'true' } });
		setIcon(icon, 'files');
		empty.createEl('h3', { text: 'Select a file' });
		empty.createEl('p', { text: 'View its current contents and saved versions.' });
		this.showPane('list');
		this.toolbarEl.hidden = false;
	}
	private renderSyncedFile(container: HTMLElement, path: string, searchResult = false): void {
		const button = action(container, '', () => this.selectFile(path), searchResult ? 'crate-history-file' : 'crate-history-tree-file');
		button.setAttribute('aria-label', path); button.disabled = this.busy;
		if (searchResult) pathLabel(button, path, this.app.vault.getFileByPath(path)?.stat.size);
		else {
			const icon = button.createSpan({ cls: 'crate-history-tree-icon', attr: { 'aria-hidden': 'true' } }); setIcon(icon, 'file-text');
			button.createSpan({ text: path.slice(path.lastIndexOf('/') + 1) });
		}
	}

	private renderFileTree(container: HTMLElement, paths: string[], prefix = ''): void {
		const folders = new Map<string, string[]>();
		const files: string[] = [];
		for (const path of paths) {
			const relative = path.slice(prefix.length); const separator = relative.indexOf('/');
			if (separator < 0) files.push(path);
			else {
				const folder = relative.slice(0, separator);
				const children = folders.get(folder) ?? []; children.push(path); folders.set(folder, children);
			}
		}
		const entries = [...[...folders.keys()].sort((a, b) => a.localeCompare(b)).map(name => ({ name, folder: true })),
			...files.sort((a, b) => a.localeCompare(b)).map(name => ({ name, folder: false }))];
		for (const entry of entries.slice(0, this.fileLimit)) {
			if (!entry.folder) { this.renderSyncedFile(container, entry.name); continue; }
			const path = `${prefix}${entry.name}/`; const expanded = this.expandedFolders.has(path);
			const row = action(container, '', () => {
				if (this.busy) return;
				if (this.expandedFolders.has(path)) this.expandedFolders.delete(path); else this.expandedFolders.add(path);
				this.renderList();
				for (const button of Array.from(this.listEl.querySelectorAll<HTMLButtonElement>('[data-folder]'))) {
					if (button.getAttribute('data-folder') === path) { button.focus(); break; }
				}
			}, 'crate-history-tree-folder');
			row.disabled = this.busy; row.setAttribute('aria-expanded', String(expanded)); row.setAttribute('data-folder', path);
			const icon = row.createSpan({ cls: 'crate-history-tree-icon', attr: { 'aria-hidden': 'true' } }); setIcon(icon, expanded ? 'chevron-down' : 'chevron-right');
			row.createSpan({ text: entry.name });
			if (expanded) this.renderFileTree(container.createDiv({ cls: 'crate-history-tree-children' }), folders.get(entry.name)!, path);
		}
		if (entries.length > this.fileLimit) action(container, 'Show more', () => { this.fileLimit += 200; this.renderList(); }).disabled = this.busy;
	}

	private load(): void { this.renderList(); }

	private renderList(): void {
		if (this.selectedPath) { this.renderVersions(); return; }
		this.listEl.empty();
		const paths = this.app.vault.getFiles().map(file => file.path).filter(path => path.toLowerCase().includes(this.search.toLowerCase())).sort((a, b) => folderOf(a).localeCompare(folderOf(b)) || a.localeCompare(b));
		const listHeader = this.listEl.createDiv({ cls: 'crate-history-list-header' });
		listHeader.createEl('p', { cls: 'crate-file-history-count', text: `${paths.length} vault ${paths.length === 1 ? 'file' : 'files'}`, attr: { role: 'status' } });
		if (this.search) {
			for (const path of paths.slice(0, this.fileLimit)) this.renderSyncedFile(this.listEl, path, true);
		} else this.renderFileTree(this.listEl, paths);
		if (!paths.length) this.listEl.createEl('p', { text: 'No vault files match this search.' });
		if (this.search && paths.length > this.fileLimit) action(this.listEl, 'More files', () => { this.fileLimit += 200; this.renderList(); }).disabled = this.busy;
	}

	private versionButton(container: HTMLElement, version: RemoteFileVersion): HTMLButtonElement {
		const button = action(container, '', () => { void this.selectVersion(version); }, 'crate-history-version');
		button.disabled = this.busy; button.setAttribute('data-version-key', version.storage_key);
		button.setAttribute('aria-current', String(version.storage_key === this.selectedVersion?.storage_key));
		{
			button.createSpan({ cls: 'crate-history-file-name', text: versionDate(version.created_at).toLocaleString() });
			button.createSpan({ cls: 'crate-history-file-folder', text: `${version.reason === 'deleted' ? 'Before deletion' : 'Before update'} · ${formatSize(version.size)}` });
		}
		if (this.isPending(version)) button.createSpan({ cls: 'crate-history-file-folder', text: 'Restore needs to finish' });
		return button;
	}

	private selectFile(path: string): void {
		if (this.busy) return;
		++this.fileRequestRevision;
		this.selectedPath = path; this.selectedVersion = undefined;
		this.fileVersions = []; this.filePage = undefined;
		this.fileError = undefined; this.toolbarEl.hidden = true;
		void this.loadFileVersions();
		void this.selectCurrent(path);
	}

	private async loadFileVersions(cursor?: string): Promise<void> {
		const path = this.selectedPath; if (!path) return;
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

	private renderVersions(): void {
		if (!this.selectedPath) return;
		const focused = this.listEl.querySelector<HTMLButtonElement>('.crate-history-version:focus')?.getAttribute('data-version-key');
		this.listEl.empty();
		action(this.listEl, '← All files', () => { if (this.busy) return; this.resetSelection(); this.load(); }, 'crate-history-list-back');
		this.listEl.createEl('h3', { text: this.selectedPath });
		const current = action(this.listEl, '', () => { void this.selectCurrent(this.selectedPath!); }, 'crate-history-file crate-history-current');
		const local = this.app.vault.getFileByPath(this.selectedPath);
		current.setAttribute('aria-label', local ? 'Current local file' : 'Current synced version');
		current.createSpan({ cls: 'crate-history-file-name', text: local ? 'On this device' : 'Synced version' });
		current.createSpan({ cls: 'crate-history-current-label', text: 'Current' });
		current.disabled = this.busy; current.setAttribute('aria-current', String(!this.selectedVersion));
		this.listEl.createEl('h4', { cls: 'crate-history-group', text: 'Versions' });
		const rows = [...new Map([...this.fileVersions, ...this.runtime.getPendingRestores()].map(row => [row.storage_key, row])).values()].filter(row => row.path === this.selectedPath).sort((a, b) => b.created_at.localeCompare(a.created_at));
		for (const version of rows) { const button = this.versionButton(this.listEl, version); if (focused === version.storage_key) button.focus(); }
		if (this.fileLoading) this.listEl.createEl('p', { text: 'Loading version history…', attr: { role: 'status' } });
		else if (this.fileError) {
			this.listEl.createEl('p', { text: this.fileError, attr: { role: 'alert' } });
			action(this.listEl, 'Retry versions', () => { void this.loadFileVersions(this.fileRetryCursor); }).disabled = this.busy;
		} else if (this.filePage?.hasMore) action(this.listEl, 'Older versions', () => { void this.loadFileVersions(this.filePage?.nextCursor); }).disabled = this.busy;
		else if (!rows.length) this.listEl.createEl('p', { text: 'No earlier versions retained for this file.' });
	}

	private previewHeader(path: string, caption: string): HTMLElement {
		this.previewEl.empty(); this.showPane('preview');
		action(this.previewEl, this.selectedPath ? '← Versions' : '← All files', () => {
			this.showPane('list'); this.listEl.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
		}, 'crate-history-back');
		const header = this.previewEl.createDiv({ cls: 'crate-history-preview-header' });
		header.createEl('h3', { text: path, attr: { tabindex: '-1' } }).focus();
		header.createEl('p', { cls: 'crate-file-history-count', text: caption });
		return header;
	}

	private async selectCurrent(path: string): Promise<void> {
		if (this.busy) return;
		this.selectedVersion = undefined; const revision = ++this.previewRevision; this.renderVersions();
		const local = this.app.vault.getFileByPath(path);
		if (local) {
			this.previewHeader(path, 'Current local file').createEl('p', { cls: 'crate-file-history-count', text: `${new Date(local.stat.mtime).toLocaleString()} · ${formatSize(local.stat.size)}` });
			const content = this.previewEl.createDiv({ cls: 'crate-history-preview-output' });
			if (local.stat.size > 256_000 || local.extension !== 'md') { content.createEl('p', { text: 'Preview is available for Markdown files up to 250 KiB. Select a saved version to compare or restore it.' }); return; }
			try {
				const text = await this.app.vault.cachedRead(local);
				if (!this.closed && revision === this.previewRevision) filePreview(content, text, 'Current local file contents');
			} catch { if (!this.closed && revision === this.previewRevision) content.createEl('p', { text: 'Could not read the local file.' }); }
			return;
		}
		const header = this.previewHeader(path, 'Current synced version');
		header.createEl('p', { cls: 'crate-history-hint', text: 'Local edits may differ' });
		const content = this.previewEl.createDiv({ cls: 'crate-history-preview-output' });
		content.createEl('p', { text: 'Loading current synced file…', attr: { role: 'status' } });
		try {
			const snapshot = await this.runtime.loadCurrentSyncedPreview(path);
			if (this.closed || revision !== this.previewRevision) return;
			content.empty(); header.createEl('p', { cls: 'crate-file-history-count', text: `${versionDate(snapshot.file.modified).toLocaleString()} · ${formatSize(snapshot.file.size)}` });
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
		this.selectedVersion = version; const revision = ++this.previewRevision; this.renderList();
		const header = this.previewHeader(version.path, `${version.reason === 'deleted' ? 'Saved before deletion' : 'Saved before update'} · ${versionDate(version.created_at).toLocaleString()} · ${formatSize(version.size)}`);
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
		output.createEl('p', { cls: 'crate-file-history-count', text: snapshot.localMissing ? 'This file is missing on this device. Added lines show the saved version.' : 'Compared with current local file' });
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
		output.createEl('p', { cls: 'crate-history-diff-summary', text: `${result.added} added ${result.added === 1 ? 'line' : 'lines'} · ${result.removed} removed ${result.removed === 1 ? 'line' : 'lines'}` });
		const code = output.createEl('pre', { attr: { tabindex: '0', 'aria-label': 'Changes from current local file to saved version' } });
		for (const line of result.lines) {
			const row = code.createSpan({ cls: `crate-history-diff-${line.kind}` });
			renderFileText(row, `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '} ${line.text}\n`);
		}
	}

	private isPending(version: RemoteFileVersion): boolean { return this.runtime.getPendingRestores().some(row => row.storage_key === version.storage_key); }

	private async restore(version: RemoteFileVersion, button: HTMLButtonElement, label: HTMLElement): Promise<void> {
		if (this.busy) return;
		this.busy = true; button.disabled = true; button.toggleClass('is-enabled', false); this.renderList();
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
			if (!this.closed) { button.disabled = false; button.toggleClass('is-enabled', true); label.setText(this.isPending(version) ? 'Resume restore' : 'Restore this version'); this.renderList(); }
		}
	}
}

export function openRemoteRecoveryModal(app: App, runtime: FileHistoryRuntime, path?: string): void {
	new RemoteRecoveryModal(app, runtime, path).open();
}
