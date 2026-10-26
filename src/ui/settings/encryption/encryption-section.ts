import { createSettingsDisclosure } from '../../plugin/settings-disclosure';
import { createModalActions, SharedModal } from '../../plugin/shared-modal';
import { openConfirmationModal } from '../../confirmation-modal';
import { Setting, type ButtonComponent } from 'obsidian';
import type CratePlugin from '../../../plugin/CratePlugin';
import { encryptVault, loadDeviceEncryptionKeys, openEncryptionConnection, prepareEncryptionKeys, readEncryptionStatus, unlockVault, verifySetupRecovery } from '../../../plugin/encryption-setup';
import type { VaultKeyBundle } from '../../../encryption/key-bundle';
import type { WorkerApiHttpClient } from '../../../sync/worker-api/http';
import { readServerEncryption } from '../../../sync/encryption/server-encryption';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { createLogger } from '../../../sync/logger';
import { errorMessage } from '../../../platform/logger';
import { getPluginLifecycleSignal } from '../../../plugin/lifecycle-state';
import { EncryptionResetModal } from './encryption-reset-modal';
import { renderRecoveryVerification } from './recovery-verification';
import { renderEncryptionLoading, renderEncryptionSetup } from './encryption-setup-ui';
import { renderEncryptionManagement } from './encryption-manage-ui';
import { WebAppPairingModal } from '../web-app-pairing-modal';
import { SECRET_KEYS } from '../../../platform/secret-keys';

const log = createLogger('EncryptionSettings');

function encryptionModalTitle(state: EncryptionServerState | null): string {
	return state ? 'Manage encryption' : 'Enable encryption';
}

export function renderEncryptionSection(container: HTMLElement, plugin: CratePlugin): () => void {
	if (!plugin.settings.workerUrl) return () => {};
	const row = new Setting(container).setName('End-to-end encryption');
	const signal = getPluginLifecycleSignal(plugin);
	let disposed = false, revision = 0, loading = false, retry = false;
	let modalTitle = encryptionModalTitle(null);
	let action: ButtonComponent;
	const active = () => !disposed && !signal.aborted;
	const show = (status: string, description: string, label: string) => {
		row.descEl.empty();
		row.descEl.createEl('strong', { text: status });
		row.descEl.createSpan({ text: ` · ${description}` });
		action.setButtonText(label).setDisabled(loading);
	};
	const refresh = async () => {
		if (!active()) return;
		const request = ++revision;
		loading = false; retry = false;
		// Reset checkpoints must remain reachable after their old credentials are revoked.
		if (plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) {
			show('Reset in progress', 'Finish the sync reset on this device.', 'Resume reset'); return;
		}
		loading = true;
		show('Checking…', 'Checking this server’s encryption status.', 'Checking…');
		try {
			const state = await readEncryptionStatus(plugin, 7000);
			if (!active() || request !== revision) return;
			loading = false;
			modalTitle = encryptionModalTitle(state);
			if (state?.mode === 'resetting') show('Reset in progress', 'Continue on the device that started the reset.', 'View reset');
			else if (state) show('On', 'Synced notes, attachments and history are encrypted.', 'Manage encryption');
			else show('Off', 'Keep synced notes, attachments and history private from your server.', 'Enable encryption');
		} catch (error) {
			if (!active() || request !== revision) return;
			log.warn('Could not check server encryption status:', errorMessage(error));
			loading = false; retry = true;
			show('Status unavailable', 'Could not check this server. Retry to see whether encryption is on.', 'Retry');
		}
	};
	const changed = () => { void refresh(); };
	row.addButton(button => {
		action = button;
		button.onClick(() => {
			if (!active() || loading) return;
			if (retry) { changed(); return; }
			if (plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) new EncryptionResetModal(plugin, null, changed).open();
			else new EncryptionModal(plugin, changed, modalTitle).open();
		});
	});
	changed();
	return () => { disposed = true; };
}

class EncryptionModal extends SharedModal {
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
	private assertCurrentConnection(): void {
		this.assertConnection();
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
		this.assertCurrentConnection();
		this.setLayoutTitle(encryptionModalTitle(state));
		const keys = loadDeviceEncryptionKeys(this.plugin, state);
		if (state?.mode === 'resetting') { this.clearContent(); this.bodyEl.createEl('p', { text: 'An encryption reset is in progress. Resume it on the Obsidian device that started it.' }); return; }
		if (state && !keys) { this.clearContent(); this.status(); this.recover(state); return; }
		if (state?.mode === 'active' && keys) { this.clearContent(); this.ready(keys, state); return; }
		// Only an unencrypted server reaches setup: an encrypted one is unlocked or managed above.
		const { bundle, recovery } = await prepareEncryptionKeys(this.plugin, keys);
		if (!recovery) { this.clearContent(); this.bodyEl.createEl('p', { text: 'Restore the recovery key from your saved copy before enabling encryption.' }); return; }
		await verifySetupRecovery(null, bundle, recovery);
		this.assertCurrentConnection();
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
			assertCurrent: () => this.assertCurrentConnection(), encrypt: async (verifiedRecovery, progress) => {
			if (this.running) return;
			this.running = true;
			try {
				this.assertCurrentConnection();
				await encryptVault(this.plugin, bundle, verifiedRecovery, progress, () => this.assertCurrentConnection());
			} finally { this.running = false; this.onChanged(); }
		} });
	}
	/** An encrypted server that this device cannot unlock yet. */
	private status(): void {
		const overview = this.bodyEl.createDiv({ cls: 'crate-encryption-status' });
		new Setting(overview).setName('Vault encryption').setDesc('Active');
		const devices = createSettingsDisclosure(overview, 'This device needs a recovery key', { inline: true });
		new Setting(devices).setName('This device').setDesc('Locked · enter your saved recovery key below.');
		new Setting(devices).setName('Notification keys').setDesc('Unavailable until this device is unlocked.');
	}
	private recover(state: EncryptionServerState): void {
		this.bodyEl.createEl('p', { text: 'This server is encrypted. Enter the recovery key saved when encryption was enabled to unlock this Obsidian device.' });
		let code = '';
		new Setting(this.bodyEl).setName('Recovery key').addText(text => { text.inputEl.type = 'password'; text.setPlaceholder('Paste your recovery key').onChange(value => { code = value.trim(); }); });
		const status = this.bodyEl.createEl('p', { attr: { role: 'status' } });
		createModalActions(this.bodyEl).addButton(button => button.setButtonText('Unlock vault').setCta().onClick(async () => {
			const recoveryCode = code;
			button.setDisabled(true);
			try {
				await unlockVault(this.plugin, state, recoveryCode, () => this.assertCurrentConnection());
				await this.load();
			} catch (error) { status.setText(errorMessage(error)); }
			finally { button.setDisabled(false); }
		}));
	}
	private ready(keys: VaultKeyBundle, state: EncryptionServerState): void {
		this.disposeContent = renderEncryptionManagement(this.bodyEl, {
			connectApp: () => { this.assertCurrentConnection(); this.close(); new WebAppPairingModal(this.plugin).open(); },
			copyRecovery: async () => {
				this.assertCurrentConnection();
				const recovery = this.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY);
				if (!recovery) throw new Error('This device does not have a saved recovery key. Keep your original saved copy.');
				await navigator.clipboard.writeText(recovery);
			},
			turnOff: () => { this.close(); new EncryptionResetModal(this.plugin, state, this.onChanged).open(); },
			advanced: container => {
				container.createEl('p', { cls: 'crate-encryption-intro', text: 'Keep this key private. It unlocks your synced vault on Obsidian devices and in the web app. Notification text is encrypted too.' });
				const verify = createSettingsDisclosure(container, 'Check recovery key', { inline: true });
				const verification = renderRecoveryVerification(verify, state.recovery, keys, () => {}, () => this.assertCurrentConnection());

				return verification.dispose;
			},
		});
	}
}
