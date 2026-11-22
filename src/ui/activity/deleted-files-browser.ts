import { setIcon, type App } from 'obsidian';
import type { RemoteFileVersion } from '../../protocol/sync-types';
import type { SyncRuntime } from '../../sync/runtime/runtime';
import { DeletedFileList } from '../../sync/history/deleted-files';
import { parseServerTimestamp } from '../shared/format';
import { FileHistoryPanel, type FileHistoryRuntime } from './file-history-modal';
import { historyDayLabel } from './history-groups';
import { renderBackButton } from './rendering';

export type DeletedFilesRuntime = FileHistoryRuntime & Pick<SyncRuntime, 'findRemoteFiles'>;

const SEARCH_DELAY_MS = 300;

function formatTime(date: Date): string {
	return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function formatDate(date: Date): string {
	return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

/** Notes read better without their extension; other files keep theirs. */
function displayName(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name.length > 3 && name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

/** Vault history → **Deleted files**: files deleted within the server's history period, grouped
 * by day. Selecting one shows its versions beside it, where **Restore this version** brings it back. */
export class DeletedFilesBrowser {
	private disposed = false;
	private list?: DeletedFileList;
	private rows: RemoteFileVersion[] = [];
	private revision = 0;
	private loading = false;
	private error?: string;
	private search = '';
	private searchTimer?: number;
	private selectedPath?: string;
	private panel?: FileHistoryPanel;
	private readonly listEl: HTMLElement;
	private readonly fileEl: HTMLElement;
	readonly searchEl: HTMLInputElement;

	constructor(private readonly container: HTMLElement, private readonly app: App, private readonly runtime: DeletedFilesRuntime) {
		container.addClass('crate-file-history', 'crate-deleted-browser');
		const workspace = container.createDiv({ cls: 'crate-deleted-browser-workspace' });
		const files = workspace.createDiv({ cls: 'crate-deleted-files-pane' });
		const search = files.createDiv({ cls: 'crate-deleted-search' });
		setIcon(search.createSpan({ cls: 'crate-deleted-search-icon', attr: { 'aria-hidden': 'true' } }), 'search');
		this.searchEl = search.createEl('input', { attr: { type: 'search', placeholder: 'Search deleted files', 'aria-label': 'Search deleted files', spellcheck: 'false' } });
		this.searchEl.addEventListener('input', () => {
			window.clearTimeout(this.searchTimer);
			const value = this.searchEl.value;
			this.searchTimer = window.setTimeout(() => { void this.reload(value); }, SEARCH_DELAY_MS);
		});
		this.listEl = files.createEl('nav', { cls: 'crate-deleted-files', attr: { 'aria-label': 'Deleted files' } });
		this.fileEl = workspace.createEl('section', { cls: 'crate-deleted-file-pane', attr: { 'aria-label': 'Deleted file' } });
		this.fileEl.createEl('p', { cls: 'crate-history-description', text: 'Select a deleted file to see its versions and restore it.' });
		this.showPane('files');
		void this.reload('');
	}

	dispose(): void {
		this.disposed = true;
		++this.revision;
		window.clearTimeout(this.searchTimer);
		this.panel?.dispose();
		this.panel = undefined;
	}

	private showPane(pane: 'files' | 'file'): void { this.container.setAttribute('data-pane', pane); }

	private reload(search: string): Promise<void> {
		this.search = search.trim();
		this.list = new DeletedFileList({
			listVersions: query => this.runtime.listRecentFileVersions(query),
			remotePaths: paths => this.runtime.findRemoteFiles(paths),
			localExists: path => this.app.vault.adapter.exists(path),
		}, search);
		this.rows = [];
		return this.loadMore();
	}

	private async loadMore(): Promise<void> {
		const list = this.list;
		if (!list) return;
		const revision = ++this.revision;
		this.loading = true; this.error = undefined; this.render();
		try {
			const rows = await list.next();
			if (this.disposed || revision !== this.revision) return;
			this.rows.push(...rows);
		} catch (error) {
			if (this.disposed || revision !== this.revision) return;
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (!this.disposed && revision === this.revision) { this.loading = false; this.render(); }
		}
	}

	private render(): void {
		const active = this.listEl.ownerDocument.activeElement;
		const focused = active && this.listEl.contains(active) ? active.getAttribute('data-path') : null;
		this.listEl.empty();
		let day: string | undefined;
		for (const version of this.rows) {
			const deleted = parseServerTimestamp(version.created_at);
			const label = historyDayLabel(deleted);
			if (label !== day) { day = label; this.listEl.createEl('h3', { cls: 'crate-history-group', text: label }); }
			const slash = version.path.lastIndexOf('/');
			const button = this.listEl.createEl('button', { cls: 'crate-history-version crate-deleted-file', attr: {
				type: 'button', 'data-path': version.path, 'aria-current': String(version.path === this.selectedPath), title: version.path,
			} });
			const text = button.createDiv({ cls: 'crate-deleted-file-text' });
			text.createSpan({ cls: 'crate-history-file-name', text: displayName(version.path) });
			const meta = slash > 0 ? `${version.path.slice(0, slash)} · ${formatTime(deleted)}` : formatTime(deleted);
			text.createSpan({ cls: 'crate-history-file-folder', text: meta });
			setIcon(button.createSpan({ cls: 'crate-deleted-file-chevron', attr: { 'aria-hidden': 'true' } }), 'chevron-right');
			button.addEventListener('click', () => this.select(version));
			if (focused === version.path) button.focus();
		}
		if (this.loading) this.listEl.createEl('p', { text: 'Looking for deleted files…', attr: { role: 'status' } });
		else if (this.error) {
			this.listEl.createEl('p', { text: this.error, attr: { role: 'alert' } });
			this.action('Retry', () => { void this.loadMore(); });
		} else if (this.list?.hasMore) this.action('Load more', () => { void this.loadMore(); });
		else if (!this.rows.length) this.listEl.createEl('p', { text: this.search
			? 'No deleted files match your search.'
			: 'No deleted files. Deleted files stay here for the history period set in Crate settings.' });
	}

	private action(text: string, run: () => void): void {
		this.listEl.createEl('button', { text, cls: 'crate-activity-action crate-deleted-files-more', attr: { type: 'button' } }).addEventListener('click', run);
	}

	private select(version: RemoteFileVersion): void {
		const path = version.path;
		if (path !== this.selectedPath || !this.panel) {
			this.panel?.dispose();
			this.selectedPath = path;
			for (const row of Array.from(this.listEl.querySelectorAll('[data-path]'))) row.setAttribute('aria-current', String(row.getAttribute('data-path') === path));
			this.fileEl.empty();
			renderBackButton(this.fileEl, 'crate-deleted-back', 'Deleted files', () => {
				this.showPane('files');
				this.listEl.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
			});
			const header = this.fileEl.createDiv({ cls: 'crate-deleted-file-header' });
			header.createEl('h3', { text: path, attr: { tabindex: '-1' } });
			const deleted = parseServerTimestamp(version.created_at);
			header.createEl('p', { cls: 'crate-history-description', text: `Deleted ${formatDate(deleted)}`, attr: { title: deleted.toLocaleString() } });
			this.panel = new FileHistoryPanel(this.app, this.runtime, path, this.fileEl, { selectLatest: true, onRestoreSettled: () => { void this.dropRestored(path); } });
		}
		this.showPane('file');
		// One pane at a time: move focus with it. Side by side, focus stays on the list.
		if (!this.listEl.getClientRects().length) this.fileEl.querySelector<HTMLElement>('.crate-deleted-file-header h3')?.focus({ preventScroll: true });
	}

	/** A restore brings the file back, so it leaves the list. Its versions stay in view. */
	private async dropRestored(path: string): Promise<void> {
		try {
			const [local, remote] = await Promise.all([this.app.vault.adapter.exists(path), this.runtime.findRemoteFiles([path])]);
			if (this.disposed || !(local || remote.has(path))) return;
			this.rows = this.rows.filter(row => row.path !== path);
			this.render();
		} catch { /* The row stays until the list reloads. */ }
	}
}
