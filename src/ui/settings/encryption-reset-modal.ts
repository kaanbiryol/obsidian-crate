import { createModalActions, createModalFooter } from '../shared/modal-elements';
import { Notice, Setting, type ButtonComponent } from 'obsidian';
import type CratePlugin from '../../main';
import type { EncryptionServerState } from '../../encryption/server-state';
import { SharedModal } from '../shared/SharedModal';
import { SECRET_KEYS } from '../../plugin/settings-types';
import { getPluginLifecycleSignal } from '../../plugin/lifecycle-state';
import { errorMessage } from '../../plugin/logger';

export class EncryptionResetModal extends SharedModal {
	private running = false;
	private confirmed = false;
	private readonly expected: { workerUrl: string; authToken: string };
	constructor(private readonly plugin: CratePlugin, private readonly state: EncryptionServerState | null, private readonly onChanged: () => void = () => {}) {
		super(plugin.app);
		this.expected = { workerUrl: plugin.settings.workerUrl, authToken: plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) ?? '' };
	}
	onOpen(): void {
		const resuming = !!this.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET);
		this.openLayout(resuming ? 'Resume encryption reset' : 'Reset sync and turn off encryption');
		this.bodyEl.createEl('p', { text: 'Crate will delete all synced server files, retained history, checkpoints and saved sync state. Files that exist only on the server will be lost. This cannot be undone.' });
		this.bodyEl.createEl('p', { text: 'Files in this device’s local Obsidian vault stay on this device and will be uploaded again using your current sync exclusions. The server will be able to read their contents. Sync and notifications pause during the reset.' });
		this.bodyEl.createEl('p', { text: 'Other Obsidian devices must disconnect and reconnect. Web apps must log out and open a fresh enrollment link; logging out discards their drafts and pending edits. Enable notifications again after enrollment.' });
		this.bodyEl.createEl('p', { text: 'Existing backup copies stay as they are. Encrypted copies still need your old recovery key; save it before continuing if you need those copies.' });
		const recovery = this.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY);
		if (recovery) new Setting(this.bodyEl).setName('Old recovery key').addButton(button => button.setButtonText('Copy recovery key').onClick(async () => {
			await navigator.clipboard.writeText(recovery); new Notice('Recovery key copied');
		}));
		let action: ButtonComponent | undefined;
		this.confirmed = resuming;
		if (!resuming) new Setting(this.bodyEl).setName('Confirm data loss').setDesc('Type reset to delete remote data and turn off encryption.').addText(text => {
			text.setPlaceholder('Type confirmation').onChange(value => { this.confirmed = value === 'reset'; action?.setDisabled(!this.confirmed || this.running); });
		});
		const status = this.bodyEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
		createModalActions(createModalFooter(this.contentEl)).addButton(button => {
			action = button;
			button.setButtonText(resuming ? 'Resume reset' : 'Reset sync and turn off encryption').setDestructive().setDisabled(!this.confirmed).onClick(async () => {
				if (!this.confirmed || this.running) return;
				this.running = true; button.setDisabled(true);
				try {
					await this.plugin.syncRuntime.turnOffEncryption(this.state, message => status.setText(message), this.expected, getPluginLifecycleSignal(this.plugin));
					new Notice('Encryption is off. Reconnect your other Obsidian devices and web apps.');
					this.close();
				} catch (error) {
					status.setText(errorMessage(error) + (this.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)
						? ' Reopen Manage encryption to resume. Keep this device’s local vault and saved reset data.' : ''));
				} finally { this.running = false; this.onChanged(); }
			});
		});
	}
}
