import { Modal, Notice, Setting, type App } from 'obsidian';
import type { RemoteFileVersion } from '../protocol/sync-types';
import type { SyncRuntime } from '../sync/runtime';
import { openConfirmationModal } from './confirmation-modal';

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

class RemoteRecoveryModal extends Modal {
	constructor(app: App, private readonly runtime: SyncRuntime) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Restore remote file');
		this.contentEl.createEl('p', { text: 'Loading retained file versions…' });
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		try {
			const versions = await this.runtime.listRecentFileVersions();
			this.renderVersions(versions);
		} catch (error) {
			this.contentEl.empty();
			this.contentEl.createEl('p', {
				text: `Could not load retained files: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	private renderVersions(versions: RemoteFileVersion[]): void {
		this.contentEl.empty();
		if (versions.length === 0) {
			this.contentEl.createEl('p', { text: 'No restorable remote files were found.' });
			return;
		}

		this.contentEl.createEl('p', {
			text: 'Crate retains replaced and deleted remote files for 30 days.',
		});
		for (const version of versions) {
			const created = new Date(version.created_at).toLocaleString();
			new Setting(this.contentEl)
				.setName(version.path)
				.setDesc(`${version.reason === 'deleted' ? 'Deleted' : 'Replaced'} ${created} · ${formatSize(version.size)}`)
				.addButton(button => button
					.setButtonText('Restore')
					.onClick(async () => {
						const confirmed = await openConfirmationModal(this.app, {
							title: 'Restore remote file',
							message: `Restore ${version.path} and sync it to this device?`,
							details: ['The current remote version, if any, will remain recoverable for 30 days.'],
							confirmText: 'Restore',
						});
						if (!confirmed) return;
						button.setDisabled(true).setButtonText('Restoring…');
						try {
							const result = await this.runtime.restoreRecentFileVersion(version);
							if (!result.success) throw new Error(result.errors[0] || 'Sync failed after restore');
							new Notice(`Restored ${version.path}`);
							this.close();
						} catch (error) {
							new Notice(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
							button.setDisabled(false).setButtonText('Restore');
						}
					}));
		}
	}
}

export function openRemoteRecoveryModal(app: App, runtime: SyncRuntime): void {
	new RemoteRecoveryModal(app, runtime).open();
}
