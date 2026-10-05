import { createSettingsDisclosure } from '../plugin/settings-disclosure';
import { createModalActions } from '../plugin/modal-elements';
import { Setting, type ButtonComponent } from 'obsidian';
import type CratePlugin from '../../main';
import { SharedModal } from '../plugin/SharedModal';
import { SECRET_KEYS } from '../../plugin/settings-types';
import { loadEncryptionKeys, saveEncryptionKeys } from '../../plugin/encryption-storage';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode, openRecoveryBundle, sealRecoveryBundle, type VaultKeyBundle } from '../../encryption/key-bundle';
import { WorkerApiHttpClient } from '../../sync/worker-api/http';
import { convertEncryptedVault, readServerEncryption, assertEncryptionKeys } from '../../sync/encryption-conversion';
import { isReadingScopeExtension, READING_ENCRYPTION_CAPABILITY, createEncryptionState, type EncryptionServerState } from '../../encryption/server-state';
import { errorMessage } from '../../plugin/logger';
import { getPluginLifecycleSignal } from '../../plugin/lifecycle-state';
import { normalizeWorkerUrl } from '../../sync/worker-url';
import { EncryptionResetModal } from './encryption-reset-modal';
import { renderRecoveryVerification } from './recovery-verification';
import { verifyRecoveryCode } from '../../encryption/recovery-verification';
import { resumeEncryptedFolderMoves, useServerEncryptionFolders } from '../../plugin/encryption-folder-moves';
import { renderEncryptionLoading, renderEncryptionSetup } from './encryption-setup-ui';
import { renderEncryptionManagement } from './encryption-manage-ui';
import { WebAppPairingModal } from './web-app-pairing-modal';

function encryptionModalTitle(state: EncryptionServerState | null): string {
	return state?.mode === 'converting' ? 'Resume encryption' : state ? 'Manage encryption' : 'Enable encryption';
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
		if (plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) {
			modalTitle = 'Resume folder move';
			show('Folder move pending', 'Finish updating encryption for the moved folder.', 'Resume folder move'); return;
		}
		const url = normalizeWorkerUrl(plugin.settings.workerUrl), token = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) ?? '';
		loading = true;
		show('Checking…', 'Checking this server’s encryption status.', 'Checking…');
		try {
			const http = new WorkerApiHttpClient(url, token);
			http.setAbortSignal(signal);
			const state = await readServerEncryption(http, 7000);
			if (!active() || request !== revision) return;
			if (url !== normalizeWorkerUrl(plugin.settings.workerUrl) || token !== (plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) ?? '')) {
				throw new Error('The server connection changed.');
			}
			loading = false;
			modalTitle = encryptionModalTitle(state);
			if (state?.mode === 'resetting') show('Reset in progress', 'Continue on the device that started the reset.', 'View reset');
			else if (state?.mode === 'converting') show('Converting…', 'Sync and notifications are paused until conversion finishes.', 'Resume conversion');
			else if (state) show('On', 'Synced notes, attachments and history are encrypted.', 'Manage encryption');
			else show('Off', 'Keep synced notes, attachments and history private from your server.', 'Enable encryption');
		} catch {
			if (!active() || request !== revision) return;
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
	private readonly authToken: string;
	private running = false;
	private disposeContent?: () => void;
	constructor(private readonly plugin: CratePlugin, private readonly onChanged: () => void, private readonly initialTitle: string) {
		super(plugin.app);
		this.authToken = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) ?? '';
		this.http = new WorkerApiHttpClient(plugin.settings.workerUrl, this.authToken);
		this.http.setAbortSignal(getPluginLifecycleSignal(plugin));
	}
	onClose(): void {
		this.disposeContent?.();
		super.onClose();
	}
	private assertCurrentConnection(): void {
		getPluginLifecycleSignal(this.plugin).throwIfAborted();
		if (this.http.getWorkerUrl() !== normalizeWorkerUrl(this.plugin.settings.workerUrl)
			|| this.authToken !== this.plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN)) throw new Error('The server connection changed. Reopen Manage encryption.');
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
		if (this.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) {
			this.clearContent();
			this.bodyEl.createEl('p', { text: 'A folder move is saved on this device. Resume to update encryption, retained history and folder settings. Keep this device’s Crate data until it finishes. Web apps follow renamed folders automatically; choosing a different folder requires a fresh setup link.' });
			const progress = this.bodyEl.createEl('p', { attr: { role: 'status' } });
			new Setting(this.bodyEl).setName('Encrypted folder move').addButton(button => button.setButtonText('Resume folder move').setCta().onClick(async () => {
				button.setDisabled(true);
				try { this.assertCurrentConnection(); await resumeEncryptedFolderMoves(this.plugin, text => progress.setText(text)); await this.load(); }
				catch (error) { progress.setText(errorMessage(error)); }
				finally { button.setDisabled(false); this.onChanged(); }
			}));
			new Setting(this.bodyEl).setName('Another device changed folders?').setDesc('Use the server’s completed folder settings and cancel this device’s pending folder mapping. Local files stay where they are; normal sync reconciles them.').addButton(button => button.setButtonText('Use server folder settings').onClick(async () => {
				button.setDisabled(true);
				try { this.assertCurrentConnection(); await useServerEncryptionFolders(this.plugin); await this.load(); }
				catch (error) { progress.setText(errorMessage(error)); }
				finally { button.setDisabled(false); this.onChanged(); }
			}));
			return;
		}
		const state = await readServerEncryption(this.http);
		this.assertCurrentConnection();
		this.setLayoutTitle(encryptionModalTitle(state));
		let keys: VaultKeyBundle | null = null;
		try { keys = loadEncryptionKeys(this.plugin.secretStorage); if (state && keys && !isReadingScopeExtension(state, createEncryptionState(keys, state.recovery))) assertEncryptionKeys(state, keys); }
		catch (error) { if (!state) throw error; keys = null; }
		if (state?.mode === 'resetting') { this.clearContent(); this.bodyEl.createEl('p', { text: 'An encryption reset is in progress. Resume it on the Obsidian device that started it.' }); return; }
		if (state && !keys) { this.clearContent(); this.status(state, null); this.recover(state); return; }
		if (state?.mode === 'active' && keys) { this.clearContent(); this.ready(keys, state); return; }
		let bundle = keys;
		let recovery = this.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY);
		if (!bundle) {
			if (!(await this.http.getServerInfo()).capabilities.includes(READING_ENCRYPTION_CAPABILITY)) throw new Error('Update your Crate server before encrypting Reading.');
			bundle = createVaultKeyBundle();
			const { folders, readingFolder } = await this.http.requestJson<{ folders: string[]; readingFolder?: string | null }>('/encryption/folders');
			for (const folder of new Set([...folders, this.plugin.remindersSettings.remindersFolderPath])) bundle = addReminderScope(bundle, folder);
			bundle = addReminderScope(bundle, readingFolder ?? this.plugin.settings.reading.folderPath, 'reading');
			recovery = await generateRecoveryCode();
		}
		if (!recovery) { this.clearContent(); this.status(state, keys); this.bodyEl.createEl('p', { text: 'Restore the recovery key from your saved copy before resuming encryption.' }); if (state) this.recover(state); return; }
		const finalBundle = bundle, finalRecovery = recovery;
		const recoveryEnvelope = state?.recovery ?? await sealRecoveryBundle(finalBundle, finalRecovery);
		try { await verifyRecoveryCode(recoveryEnvelope, finalRecovery, finalBundle); }
		catch (error) {
			this.assertCurrentConnection();
			if (!state) throw error;
			this.clearContent();
			this.bodyEl.createEl('p', { text: 'This device’s saved recovery key could not be verified. Restore it from your saved copy before resuming encryption.' });
			this.recover(state); return;
		}
		this.assertCurrentConnection();
		this.clearContent();
		this.disposeContent = renderEncryptionSetup(this.bodyEl, { recovery: finalRecovery, resuming: Boolean(state),
			automaticSync: () => this.plugin.settings.automaticSync,
			setTitle: title => this.setLayoutTitle(title), close: () => this.close(),
			manage: () => { this.setLayoutTitle('Manage encryption'); void this.load().catch(error => this.unavailable(error)); },
			assertCurrent: () => this.assertCurrentConnection(), encrypt: async (verifiedRecovery, progress) => {
			if (this.running) return;
			this.running = true;
			try {
				this.assertCurrentConnection();
				// Freeze the engine before changing server mode. Local changes and
				// durable upload receipts reconcile through encrypted sync afterward.
				await this.plugin.syncRuntime.runEncryptionSetup(async () => {
					this.assertCurrentConnection();
					saveEncryptionKeys(this.plugin.secretStorage, finalBundle, verifiedRecovery);
					await convertEncryptedVault(this.http, finalBundle, verifiedRecovery, progress);
				});
			} finally { this.running = false; this.onChanged(); }
		} });
	}
	private status(state: EncryptionServerState | null, keys: VaultKeyBundle | null): Setting {
		const overview = this.bodyEl.createDiv({ cls: 'crate-encryption-status' });
		const vault = new Setting(overview).setName('Vault encryption').setDesc(state?.mode === 'active' ? 'Active · conversion complete'
			: state ? 'Conversion in progress · sync and notifications are paused. Resume below.' : 'Not enabled');
		if (!state) return vault;
		const devices = createSettingsDisclosure(overview, keys ? 'This device is unlocked' : 'This device needs a recovery key', { inline: true });
		new Setting(devices).setName('This device').setDesc(keys ? 'Unlocked · keys saved on this device.' : 'Locked · enter your saved recovery key below.');
		const scope = keys?.scopes.find(item => item.folderPath === this.plugin.remindersSettings.remindersFolderPath);
		new Setting(devices).setName('Notification keys').setDesc(!keys ? 'Unavailable until this device is unlocked.'
			: !scope ? 'This reminders folder was not included in encryption setup. Select an enrolled folder in Reminders settings.'
			: state.mode === 'converting' ? 'Saved · notifications resume after conversion.'
			: 'Ready for enrollment · web apps use the same recovery key and need notification permission.');
		return vault;
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
				const bundle = await openRecoveryBundle(state.recovery, recoveryCode); assertEncryptionKeys(state, bundle);
				await this.plugin.syncRuntime.runEncryptionSetup(async () => { this.assertCurrentConnection(); saveEncryptionKeys(this.plugin.secretStorage, bundle, recoveryCode); });
				await this.load();
			} catch (error) { status.setText(errorMessage(error)); }
			finally { button.setDisabled(false); }
		}));
	}
	private ready(keys: VaultKeyBundle, state: EncryptionServerState): void {
    if (!state.scopes.some(scope => scope.folderPath === this.plugin.settings.reading.folderPath && scope.purpose === 'reading')) {
      new Setting(this.bodyEl).setName('Encrypt reading for the web app').setDesc('Encrypt your reading folder and its retained notes using your existing recovery key. Sync pauses during setup.').addButton(button => button.setButtonText('Add encrypted reading').onClick(async () => {
        button.setDisabled(true);
        const progress = this.bodyEl.createEl('p', { attr: { role: 'status' } });
        try {
          const recovery = this.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY);
          if (!recovery) throw new Error('Recover this vault with your saved recovery key first.');
          if (!(await this.http.getServerInfo()).capabilities.includes(READING_ENCRYPTION_CAPABILITY)) throw new Error('Update your Crate server before encrypting Reading.');
          const bundle = addReminderScope(keys, this.plugin.settings.reading.folderPath, 'reading');
          await this.plugin.syncRuntime.runEncryptionSetup(async () => {
            this.assertCurrentConnection(); saveEncryptionKeys(this.plugin.secretStorage, bundle, recovery);
            await convertEncryptedVault(this.http, bundle, recovery, message => progress.setText(message));
          });
          await this.load();
        } catch (error) { progress.setText(errorMessage(error) + ' Reopen Manage encryption to resume.'); }
        finally { button.setDisabled(false); this.onChanged(); }
      }));
    }
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
