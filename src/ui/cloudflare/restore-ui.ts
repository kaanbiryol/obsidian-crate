import { Setting, type App } from 'obsidian';
import { SharedModal } from '../plugin/shared-modal';
import type { BackupChoice } from '../../cloudflare/restore/archive';

export class BackupPicker extends SharedModal {
	constructor(app: App, private readonly backups: BackupChoice[], private readonly select: (backup: BackupChoice) => void) { super(app); }
	onOpen(): void {
		this.openLayout('Restore server backup');
		this.bodyEl.createEl('p', { text: 'Choose the server backup to restore. Crate will verify it and create a separate server with its files and history. Your current server and local vault are kept.' });
		if (!this.backups.length) this.bodyEl.createEl('p', { text: 'No completed upgrade backups were found for this server.' });
		for (const backup of this.backups) {
			const size = backup.manifest.objects.reduce((total, item) => total + item.size, 0);
			new Setting(this.bodyEl).setName(new Date(backup.manifest.createdAt).toLocaleString())
				.setDesc(`${backup.manifest.objects.length.toLocaleString()} files and versions · ${(size / 1024 / 1024).toFixed(1)} MB`)
				.addButton(button => button.setButtonText('Restore…').onClick(() => { this.close(); this.select(backup); }));
		}
	}
}

export class RestoredServer extends SharedModal {
	constructor(app: App, private readonly url: string, private readonly actions: { connect: () => void; restoreAnother: () => void }) { super(app); }
	onOpen(): void {
		this.openLayout('Backup restored');
		this.bodyEl.createEl('p', { text: `Your separate server is ready: ${this.url}` });
		this.bodyEl.createEl('p', { text: 'Back up your local vault before connecting, then select the server marked “restored”. Devices need to be connected again.' });
		new Setting(this.bodyEl).setName('Connect to the restored server')
			.addButton(button => button.setButtonText('Choose server…').onClick(() => { this.close(); this.actions.connect(); }));
		new Setting(this.bodyEl).setName('Restore another backup')
			.setDesc('Create another separate server from a different backup.')
			.addButton(button => button.setButtonText('Choose backup…').onClick(() => { this.close(); this.actions.restoreAnother(); }));
	}
}
