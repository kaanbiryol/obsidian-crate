import { createSettingsDisclosure } from '../../plugin/settings-disclosure';
import { createModalActions, SharedModal } from '../../plugin/shared-modal';
import { openConfirmationModal } from '../../plugin/confirmation-modal';
import { Setting } from 'obsidian';
import type CratePlugin from '../../../plugin/CratePlugin';
import { encryptionModalState, encryptVault, loadDeviceEncryptionKeys, openEncryptionConnection, prepareEncryptionKeys, syncWithoutEncryption, unlockVault, verifySetupRecovery } from '../../../plugin/encryption-setup';
import type { VaultKeyBundle } from '../../../encryption/key-bundle';
import type { WorkerApiHttpClient } from '../../../sync/worker-api/http';
import { readServerEncryption } from '../../../sync/encryption/server-encryption';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { errorMessage } from '../../../platform/logger';
import { EncryptionResetModal } from './encryption-reset-modal';
import { renderRecoveryVerification } from './recovery-key-setting';
import { renderEncryptionLoading, renderEncryptionSetup } from './encryption-setup-ui';
import { renderEncryptionManagement } from './encryption-manage-ui';
import { WebAppPairingModal } from '../web-app-pairing-modal';
import { DeviceKeyPairingModal } from '../device-key-pairing-modal';
import { DEVICE_PAIRING_CAPABILITY } from '../../../protocol/device-pairing';
import { SECRET_KEYS } from '../../../platform/secret-keys';

export function encryptionModalTitle(state: EncryptionServerState | null): string {
	return state ? 'Manage encryption' : 'Enable encryption';
}

export class EncryptionModal extends SharedModal {
	private readonly http: WorkerApiHttpClient;
	private readonly assertConnection: () => void;
	private running = false;
	private disposeContent?: () => void;
	constructor(private readonly plugin: CratePlugin, private readonly onChanged: () => void, private readonly initialTitle: string) {
		super(plugin.app);
		({ http: this.http, assertCurrent: this.assertConnection } = openEncryptionConnection(plugin));
	}
	onClose(): void {
		this.disposeContent?.();
		super.onClose();
	}
	onOpen(): void {
		this.openLayout(this.initialTitle);
		this.modalEl.addClass('crate-encryption-modal');
		void this.load().catch(error => this.unavailable(error));
	}
	private clearContent(): void {
		this.disposeContent?.(); this.disposeContent = undefined;
		this.bodyEl.empty();
		this.bodyEl.removeClass('crate-encryption-setup');
		this.bodyEl.removeClass('crate-encryption-manage');
	}
	private unavailable(error: unknown): void {
		this.clearContent();
		new Setting(this.bodyEl).setName('Encryption status unavailable').setDesc(errorMessage(error));
		createModalActions(this.bodyEl).addButton(button => button.setButtonText('Retry connection').onClick(async () => {
			button.setDisabled(true);
			try { await this.load(); } catch (failure) { this.unavailable(failure); }
		}));
	}
	private async load(): Promise<void> {
		this.clearContent();
		renderEncryptionLoading(this.bodyEl);
		try { await this.loadContent(); }
		finally { this.bodyEl.setAttribute('aria-busy', 'false'); }
	}
	private async loadContent(): Promise<void> {
		const state = await readServerEncryption(this.http);
		this.assertConnection();
		this.setLayoutTitle(encryptionModalTitle(state));
		const view = encryptionModalState(state, loadDeviceEncryptionKeys(this.plugin, state), this.plugin.settings);
		switch (view.kind) {
			case 'resetting': this.clearContent(); this.bodyEl.createEl('p', { text: 'An encryption reset is in progress. Resume it on the Obsidian device that started it.' }); return;
			case 'locked': {
				// Servers that pair devices also accept key requests from a device without keys.
				const pairing = view.state.mode === 'active' && (await this.http.getServerInfo()).capabilities.includes(DEVICE_PAIRING_CAPABILITY);
				this.assertConnection();
				this.clearContent(); this.status(); this.recover(view.state, pairing); return;
			}
			case 'ready': this.clearContent(); this.ready(view.keys, view.state); return;
			case 'downgraded': this.clearContent(); this.downgraded(); return;
			case 'setup': await this.setup(view.keys);
		}
	}
	private async setup(keys: VaultKeyBundle | null): Promise<void> {
		const { bundle, recovery } = await prepareEncryptionKeys(this.plugin, keys);
		if (!recovery) { this.clearContent(); this.bodyEl.createEl('p', { text: 'Restore the recovery key from your saved copy before enabling encryption.' }); return; }
		await verifySetupRecovery(null, bundle, recovery);
		this.assertConnection();
		this.clearContent();
		this.disposeContent = renderEncryptionSetup(this.bodyEl, { recovery,
			automaticSync: () => this.plugin.settings.automaticSync,
			setTitle: title => this.setLayoutTitle(title), close: () => this.close(),
			manage: () => { this.setLayoutTitle('Manage encryption'); void this.load().catch(error => this.unavailable(error)); },
			confirm: () => openConfirmationModal(this.app, {
				title: 'Turn on encryption?',
				message: 'Crate replaces the server copy of your vault with this device’s vault, encrypted. This cannot be undone.',
				details: [
					'The server copy, its version history and checkpoints are deleted. Earlier versions cannot be restored.',
					'Files this device does not sync, such as excluded folders, are deleted from the server.',
					'Other Obsidian devices must reconnect and enter the recovery key. Web apps must log out and open a fresh setup link; logging out discards their drafts and pending edits.',
				],
				confirmText: 'Delete server copy and encrypt',
				warning: true,
				typedConfirmation: 'encrypt',
			}),
			assertCurrent: () => this.assertConnection(), encrypt: async (verifiedRecovery, progress) => {
			if (this.running) return;
			this.running = true;
			try {
				this.assertConnection();
				await encryptVault(this.plugin, bundle, verifiedRecovery, progress, () => this.assertConnection());
			} finally { this.running = false; this.onChanged(); }
		} });
	}
	/** This vault synced encrypted before, but the server now reports no encryption. */
	private downgraded(): void {
		this.bodyEl.createEl('p', { text: 'This vault was synced with end-to-end encryption, but this server reports that encryption is off. Crate does not send notes to it until you choose.' });
		this.bodyEl.createEl('p', { text: 'If you moved to a new, empty server, turn encryption on for it. If you turned encryption off on purpose, sync without encryption. Otherwise, check the server address.' });
		const status = this.bodyEl.createEl('p', { attr: { role: 'status' } });
		const actions = createModalActions(this.bodyEl);
		actions.addButton(button => button.setButtonText('Turn on encryption').setCta().onClick(async () => {
			button.setDisabled(true);
			try {
				this.assertConnection();
				this.clearContent();
				await this.setup(null);
			} catch (error) { this.unavailable(error); }
		}));
		actions.addButton(button => button.setButtonText('Sync without encryption').setDestructive().onClick(async () => {
			const confirmed = await openConfirmationModal(this.app, {
				title: 'Sync without encryption?',
				message: 'Crate will send this vault’s notes to this server as readable text.',
				confirmText: 'Sync without encryption',
				warning: true,
			});
			if (!confirmed) return;
			button.setDisabled(true);
			try {
				await syncWithoutEncryption(this.plugin, () => this.assertConnection());
				this.close();
				this.onChanged();
			} catch (error) { status.setText(errorMessage(error)); button.setDisabled(false); }
		}));
	}
	/** An encrypted server that this device cannot unlock yet. */
	private status(): void {
		const overview = this.bodyEl.createDiv({ cls: 'crate-encryption-status' });
		new Setting(overview).setName('Vault encryption').setDesc('Active');
		const devices = createSettingsDisclosure(overview, 'This device needs a recovery key', { inline: true });
		new Setting(devices).setName('This device').setDesc('Locked · enter your saved recovery key below.');
		new Setting(devices).setName('Notification keys').setDesc('Unavailable until this device is unlocked.');
	}
	private recover(state: EncryptionServerState, pairing: boolean): void {
		this.bodyEl.createEl('p', { text: 'This server is encrypted. Enter the recovery key saved when encryption was enabled to unlock this Obsidian device.' });
		let code = '';
		new Setting(this.bodyEl).setName('Recovery key').addText(text => { text.inputEl.type = 'password'; text.setPlaceholder('Paste your recovery key').onChange(value => { code = value.trim(); }); });
		const status = this.bodyEl.createEl('p', { attr: { role: 'status' } });
		createModalActions(this.bodyEl).addButton(button => button.setButtonText('Unlock vault').setCta().onClick(async () => {
			const recoveryCode = code;
			button.setDisabled(true);
			try {
				await unlockVault(this.plugin, state, recoveryCode, () => this.assertConnection());
				await this.load();
			} catch (error) { status.setText(errorMessage(error)); }
			finally { button.setDisabled(false); }
		}));
		if (!pairing) return;
		this.bodyEl.createEl('p', { text: 'Or ask an Obsidian device that is already unlocked to send this vault’s keys.' });
		createModalActions(this.bodyEl).addButton(button => button.setButtonText('Request keys').onClick(() => {
			this.assertConnection(); this.close(); new DeviceKeyPairingModal(this.plugin).open();
		}));
	}
	private ready(keys: VaultKeyBundle, state: EncryptionServerState): void {
		this.disposeContent = renderEncryptionManagement(this.bodyEl, {
			connectApp: () => { this.assertConnection(); this.close(); new WebAppPairingModal(this.plugin).open(); },
			copyRecovery: async () => {
				this.assertConnection();
				const recovery = this.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY);
				if (!recovery) throw new Error('This device does not have a saved recovery key. Keep your original saved copy.');
				await navigator.clipboard.writeText(recovery);
			},
			turnOff: () => { this.close(); new EncryptionResetModal(this.plugin, state, this.onChanged).open(); },
			advanced: container => {
				container.createEl('p', { cls: 'crate-encryption-intro', text: 'Keep this key private. It unlocks your synced vault on Obsidian devices and in the web app. Notification text is encrypted too.' });
				const verify = createSettingsDisclosure(container, 'Check recovery key', { inline: true });
				return renderRecoveryVerification(verify, state.recovery, keys, () => this.assertConnection());
			},
		});
	}
}
