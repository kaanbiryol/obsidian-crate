import { Platform, Setting, type App } from 'obsidian';
import type { RemoteFileVersion } from '../../protocol/sync-types';
import type { SyncRuntime } from '../../sync/runtime/runtime';
import { DeletedFileList } from '../../sync/history/deleted-files';
import { SharedModal } from '../plugin/shared-modal';
import { parseServerTimestamp } from '../shared/format';
import { openFileHistoryModal, type FileHistoryRuntime } from './file-history-modal';

export type RecentlyDeletedRuntime = FileHistoryRuntime & Pick<SyncRuntime, 'findRemoteFiles'>;

const SEARCH_DELAY_MS = 300;

function formatDate(date: Date): string {
	return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

/** Lists files deleted within the server's history period. Selecting one opens its file
 * history, where **Restore this version** brings it back. */
class RecentlyDeletedModal extends SharedModal {
	private closed = false;
	private list?: DeletedFileList;
	private rows: RemoteFileVersion[] = [];
	private revision = 0;
	private loading = false;
	private error?: string;
	private searchTimer?: number;
	private listEl!: HTMLElement;

	constructor(app: App, private readonly runtime: RecentlyDeletedRuntime, private readonly onClosed?: () => void) { super(app); }

	onOpen(): void {
		this.closed = false;
		this.openLayout('Recently deleted');
		this.modalEl.addClass('crate-file-history-modal', 'crate-recently-deleted-modal');
		this.modalEl.toggleClass('is-mobile', Platform.isMobile);
		this.bodyEl.addClass('crate-file-history');
		this.bodyEl.createEl('p', { cls: 'crate-history-description', text: 'Files deleted within the history period set in Crate settings. Select a file to see its versions and restore it.' });
		new Setting(this.bodyEl).setName('Search deleted files').addText(text => {
			text.setPlaceholder('Filter by file or folder').onChange(value => {
				window.clearTimeout(this.searchTimer);
				this.searchTimer = window.setTimeout(() => { void this.reload(value); }, SEARCH_DELAY_MS);
			});
			text.inputEl.type = 'search';
			text.inputEl.setAttribute('aria-label', 'Search deleted files');
		});
		this.listEl = this.bodyEl.createEl('nav', { cls: 'crate-deleted-files', attr: { 'aria-label': 'Deleted files' } });
		void this.reload('');
	}

	onClose(): void {
		this.closed = true;
		++this.revision;
		window.clearTimeout(this.searchTimer);
		super.onClose();
		this.onClosed?.();
	}

	private reload(search: string): Promise<void> {
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
			if (this.closed || revision !== this.revision) return;
			this.rows.push(...rows);
		} catch (error) {
			if (this.closed || revision !== this.revision) return;
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (!this.closed && revision === this.revision) { this.loading = false; this.render(); }
		}
	}

	private render(): void {
		const focused = this.listEl.querySelector<HTMLElement>('button:focus')?.getAttribute('data-path');
		this.listEl.empty();
		for (const version of this.rows) {
			const slash = version.path.lastIndexOf('/');
			const button = this.listEl.createEl('button', { cls: 'crate-history-version', attr: { type: 'button', 'data-path': version.path } });
			button.createSpan({ cls: 'crate-history-file-name', text: version.path.slice(slash + 1) });
			const deleted = parseServerTimestamp(version.created_at);
			const when = `Deleted ${formatDate(deleted)}`;
			button.createSpan({ cls: 'crate-history-file-folder', text: slash > 0 ? `${version.path.slice(0, slash)} · ${when}` : when, attr: { title: deleted.toLocaleString() } });
			button.addEventListener('click', () => this.openHistory(version.path));
			if (focused === version.path) button.focus();
		}
		if (this.loading) this.listEl.createEl('p', { text: 'Looking for deleted files…', attr: { role: 'status' } });
		else if (this.error) {
			this.listEl.createEl('p', { text: this.error, attr: { role: 'alert' } });
			this.action('Retry', () => { void this.loadMore(); });
		} else if (this.list?.hasMore) this.action('Load more', () => { void this.loadMore(); });
		else if (!this.rows.length) this.listEl.createEl('p', { text: 'No deleted files found.' });
	}

	private action(text: string, run: () => void): void {
		this.listEl.createEl('button', { text, cls: 'crate-deleted-files-more', attr: { type: 'button' } }).addEventListener('click', run);
	}

	private openHistory(path: string): void {
		openFileHistoryModal(this.app, this.runtime, path, () => {
			if (!this.closed) void this.dropRestored(path);
		});
	}

	/** A restore brings the file back, so it leaves the list once its history closes. */
	private async dropRestored(path: string): Promise<void> {
		try {
			const [local, remote] = await Promise.all([this.app.vault.adapter.exists(path), this.runtime.findRemoteFiles([path])]);
			if (this.closed || !(local || remote.has(path))) return;
			this.rows = this.rows.filter(row => row.path !== path);
			this.render();
		} catch { /* The row stays until the list reloads. */ }
	}
}

export function openRecentlyDeletedModal(app: App, runtime: RecentlyDeletedRuntime, onClosed?: () => void): void {
	new RecentlyDeletedModal(app, runtime, onClosed).open();
}
