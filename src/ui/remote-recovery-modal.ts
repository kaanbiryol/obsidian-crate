import { Notice, Setting, type App } from 'obsidian';
import { SharedModal } from './shared/SharedModal';
import type { FileVersionsPage } from '../protocol/sync-types';
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
	private resultsEl!: HTMLElement;
	constructor(app: App, private readonly runtime: SyncRuntime) {
		super(app);
	}

	onOpen(): void {
		this.closed = false;
		this.openLayout('Restore remote file');
		this.bodyEl.createEl('p', { text: 'Crate retains replaced and deleted remote files for 30 days.' });
		let query = '';
		const search = () => { this.search = query.trim(); void this.load(); };
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

	private async load(cursor?: string, previous: Array<string | undefined> = []): Promise<void> {
		const revision = ++this.requestRevision;
		this.resultsEl.empty();
		this.resultsEl.createEl('p', { text: 'Loading retained file versions…', attr: { role: 'status' } });
		try {
			const page = await this.runtime.listRecentFileVersions({ search: this.search || undefined, cursor });
			if (this.closed || revision !== this.requestRevision) return;
			this.renderVersions(page, cursor, previous);
		} catch (error) {
			if (this.closed || revision !== this.requestRevision) return;
			this.resultsEl.empty();
			this.resultsEl.createEl('p', {
				text: `Could not load retained files: ${error instanceof Error ? error.message : String(error)}`,
				attr: { role: 'alert' },
			});
			new Setting(this.resultsEl).addButton(button => button.setButtonText('Retry').onClick(() => this.load(cursor, previous)));
		}
	}

	private renderVersions(page: FileVersionsPage, cursor: string | undefined, previous: Array<string | undefined>): void {
		this.resultsEl.empty();
		this.resultsEl.createEl('p', {
			text: page.versions.length ? `Page ${previous.length + 1} · ${page.versions.length} retained versions` : 'No restorable remote files were found.',
			attr: { role: 'status' },
		});
		new Setting(this.resultsEl)
			.addButton(button => button.setButtonText('Previous').setDisabled(previous.length === 0)
				.onClick(() => this.load(previous.at(-1), previous.slice(0, -1))))
			.addButton(button => button.setButtonText('Next').setDisabled(!page.hasMore)
				.onClick(() => this.load(page.nextCursor, [...previous, cursor])));
		const pending = this.runtime.getPendingRestores();
		const versions = [...pending.filter(version => !page.versions.some(row => row.storage_key === version.storage_key)), ...page.versions];
		for (const version of versions) {
			const created = new Date(version.created_at).toLocaleString();
			const resuming = pending.some(row => row.storage_key === version.storage_key);
			new Setting(this.resultsEl)
				.setName(version.path)
				.setDesc(`${version.reason === 'deleted' ? 'Deleted' : 'Replaced'} ${created} · ${formatSize(version.size)}`)
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
}

export function openRemoteRecoveryModal(app: App, runtime: SyncRuntime): void {
	new RemoteRecoveryModal(app, runtime).open();
}
