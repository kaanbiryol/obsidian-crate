import { Notice, Setting, type App } from 'obsidian';
import { SharedModal } from './shared/SharedModal';
import type { FileVersionsPage, RemoteFileVersion } from '../protocol/sync-types';
import type { SyncRuntime } from '../sync/runtime';
import { openConfirmationModal } from './confirmation-modal';

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

class RemoteRecoveryModal extends SharedModal {
	private closed = false;
	private requestRevision = 0;
	private search = '';
	private versions: RemoteFileVersion[] = [];
	private resultsEl!: HTMLElement;
	constructor(app: App, private readonly runtime: SyncRuntime) {
		super(app);
	}

	onOpen(): void {
		this.closed = false;
		this.openLayout('File recovery');
		this.bodyEl.createEl('p', { text: 'Previous versions and deleted files are kept for 30 days. Choose a file, then select a version to restore.' });
		let query = '';
		const search = () => { this.search = query.trim(); this.versions = []; void this.load(); };
		new Setting(this.bodyEl).setName('Find a file').addText(text => {
			text.setPlaceholder('File or folder name').onChange(value => { query = value; });
			text.inputEl.setAttribute('aria-label', 'File or folder name');
			text.inputEl.addEventListener('keydown', event => {
				if (event.key === 'Enter') { event.preventDefault(); search(); }
			});
		}).addButton(button => button.setButtonText('Search').onClick(search));
		this.resultsEl = this.bodyEl.createDiv();
		void this.load();
	}

	onClose(): void {
		this.closed = true;
		super.onClose();
	}

	private async load(cursor?: string): Promise<void> {
		const revision = ++this.requestRevision;
		this.resultsEl.empty();
		this.resultsEl.createEl('p', { text: 'Loading retained file versions…', attr: { role: 'status' } });
		try {
			const page = await this.runtime.listRecentFileVersions({ search: this.search || undefined, cursor });
			if (this.closed || revision !== this.requestRevision) return;
			this.versions = [...new Map([...(cursor ? this.versions : []), ...page.versions].map(version => [version.storage_key, version])).values()];
			this.renderVersions(page);
		} catch (error) {
			if (this.closed || revision !== this.requestRevision) return;
			this.resultsEl.empty();
			this.resultsEl.createEl('p', {
				text: `Could not load retained files: ${error instanceof Error ? error.message : String(error)}`,
				attr: { role: 'alert' },
			});
			new Setting(this.resultsEl).addButton(button => button.setButtonText('Retry').onClick(() => this.load(cursor)));
		}
	}

	private renderVersions(page: FileVersionsPage): void {
		this.resultsEl.empty();
		const pending = this.runtime.getPendingRestores();
		const versions = [...pending.filter(version => !this.versions.some(row => row.storage_key === version.storage_key)), ...this.versions];
		const files = new Map<string, RemoteFileVersion[]>();
		for (const version of versions) {
			const group = files.get(version.path) ?? [];
			group.push(version);
			files.set(version.path, group);
		}
		this.resultsEl.createEl('p', {
			text: files.size ? `${files.size} ${files.size === 1 ? 'file' : 'files'} · ${versions.length} versions loaded${page.hasMore ? '. Load more to see older history.' : '.'}` : page.hasMore ? 'Load more to see older history.' : 'No recoverable files found.',
			attr: { role: 'status' },
		});
		for (const [path, fileVersions] of files) {
			const details = this.resultsEl.createEl('details');
			details.createEl('summary', { text: path });
			const groupEl = details.createDiv();
			fileVersions.sort((a, b) => b.created_at.localeCompare(a.created_at));
			for (const version of fileVersions) {
				const created = new Date(version.created_at).toLocaleString();
				const resuming = pending.some(row => row.storage_key === version.storage_key);
				new Setting(groupEl)
					.setName(version.reason === 'deleted' ? 'Deleted file' : 'Previous version')
					.setDesc(`${created} · ${formatSize(version.size)}`)
					.addButton(button => button
						.setButtonText(resuming ? 'Resume restore' : 'Restore')
						.onClick(async () => {
							const confirmed = resuming || await openConfirmationModal(this.app, {
								title: 'Restore remote file',
								message: `Restore ${version.path} and sync it to this device?`,
								details: ['The current remote version, if any, will remain recoverable for 30 days.'],
								confirmText: 'Restore',
							});
							if (!confirmed || this.closed) return;
							button.setDisabled(true).setButtonText('Restoring…');
							try {
								const result = await this.runtime.restoreRecentFileVersion(version);
								if (!result.success) {
									new Notice(`Restore confirmed remotely. Local sync is incomplete: ${result.errors[0] || 'Retry sync'}. Resume the saved restore to finish safely.`);
									button.setDisabled(false).setButtonText('Resume restore');
									return;
								}
								new Notice(`Restore confirmed for ${version.path}. Current remote changes synced.`);
								this.close();
							} catch (error) {
								new Notice(`Restore incomplete: ${error instanceof Error ? error.message : String(error)}`);
								button.setDisabled(false).setButtonText(this.runtime.getPendingRestores().some(row => row.storage_key === version.storage_key) ? 'Resume restore' : 'Restore');
							}
						}));
			}
		}
		if (page.hasMore) new Setting(this.resultsEl).addButton(button => button.setButtonText('Load more').onClick(() => this.load(page.nextCursor)));
	}
}

export function openRemoteRecoveryModal(app: App, runtime: SyncRuntime): void {
	new RemoteRecoveryModal(app, runtime).open();
}
