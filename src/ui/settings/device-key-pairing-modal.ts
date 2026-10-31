import { createModalActions, createModalFooter, SharedModal } from '../plugin/shared-modal';
import { Notice, type Setting } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { captureServerConnection } from '../../plugin/server-request';
import { unlockVaultWithPairedKeys } from '../../plugin/encryption-setup';
import { offerFeatureChoice } from '../../plugin/feature-settings';
import { requestAppPairing } from '../../encryption/pairing/session';
import { PAIRING_PATH, PairingEndedError, type PairingTransport } from '../../encryption/pairing/protocol';
import { validateVaultKeyBundle, type VaultKeyBundle } from '../../encryption/key-bundle';
import type { EncryptionServerState } from '../../encryption/server-state';
import { readServerEncryption } from '../../sync/encryption/server-encryption';
import { WorkerApiHttpClient } from '../../sync/worker-api/http';

/** Asks a device that holds the vault keys to send them, after both screens show the same code. */
export class DeviceKeyPairingModal extends SharedModal {
	private readonly controller = new AbortController();
	private timer?: number;
	private attempt?: Awaited<ReturnType<typeof requestAppPairing>>;
	private finished = false;
	constructor(private readonly plugin: CratePlugin) { super(plugin.app); }
	onOpen(): void {
		this.openLayout('Unlock this vault');
		this.modalEl.addClass('crate-encryption-modal', 'crate-web-pairing-modal');
		const status = this.bodyEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
		const heading = status.createEl('h3', { cls: 'crate-encryption-operation__title', text: 'Waiting for your desktop…' });
		const instructions = status.createEl('p', { cls: 'crate-encryption-intro', text: 'This vault is encrypted. Keep ' });
		instructions.createEl('strong', { text: 'Add a device' }); instructions.appendText(' open on your desktop to approve this device.');
		const codePanel = this.bodyEl.createDiv({ cls: 'crate-web-pairing-verification' });
		codePanel.createSpan({ text: 'Verification code' });
		const code = codePanel.createEl('output', { cls: 'crate-web-pairing-code', attr: { 'aria-label': 'Verification code' } });
		codePanel.hidden = true;
		const actions = createModalFooter(this.contentEl);
		actions.addClass('crate-encryption-footer');
		const addCancel = (setting: Setting) => setting.addButton(button => button.setButtonText('Cancel').onClick(() => this.close()));
		addCancel(createModalActions(actions));

		const connection = captureServerConnection(this.plugin);
		const current = () => { this.controller.signal.throwIfAborted(); connection.assertCurrent(); };
		const http = new WorkerApiHttpClient(connection.origin, connection.token ?? '');
		http.setAbortSignal(AbortSignal.any([this.controller.signal, connection.signal]));
		const transport: PairingTransport = {
			read: id => http.requestJson(`${PAIRING_PATH}${id ? `?id=${encodeURIComponent(id)}` : ''}`, undefined, 10_000),
			write: body => http.requestJson(PAIRING_PATH, { method: 'POST', body: JSON.stringify(body) }, 10_000),
		};
		let expected: EncryptionServerState | undefined;
		let confirmed = false, polling = false;
		const showError = (error: unknown) => {
			if (this.controller.signal.aborted) return;
			heading.setText('Couldn’t unlock');
			instructions.setText(error instanceof Error ? error.message : 'Could not unlock. Try again.');
			codePanel.hidden = true; actions.empty();
			if (error instanceof PairingEndedError) this.attempt = undefined;
			addCancel(createModalActions(actions)).addButton(button => button.setButtonText('Try again').onClick(() => {
				actions.empty(); addCancel(createModalActions(actions)); void poll();
			}));
		};
		const poll = async () => {
			if (polling || this.finished || this.controller.signal.aborted) return;
			polling = true;
			window.clearTimeout(this.timer);
			try {
				if (!this.attempt) {
					expected = await readServerEncryption(http) ?? undefined;
					current();
					if (expected?.mode !== 'active') throw new Error('This vault is not encrypted. Close this window and sync.');
					this.attempt = await requestAppPairing({ version: 1, id: crypto.randomUUID(), origin: new URL(connection.origin).origin,
						vaultId: expected.vaultId, generation: expected.generation }, transport, current);
				}
				const result = await this.attempt.poll();
				if (result.code) {
					code.setText(result.code);
					codePanel.hidden = false;
				}
				if (result.payload !== undefined) {
					// Receiving a packet is not proof of approval: a relay could invent keys.
					// The user confirms the same code shown on the approving device first.
					if (!confirmed) {
						heading.setText('Compare codes');
						instructions.setText('Confirm only if this code matches the one you approved on your desktop.');
						actions.empty();
						addCancel(createModalActions(actions)).addButton(button => button.setButtonText('Confirm and unlock').setCta().onClick(() => {
							button.setDisabled(true); confirmed = true; void poll();
						}));
						return;
					}
					heading.setText('Unlocking…');
					const latest = await readServerEncryption(http);
					current();
					if (!latest || latest.vaultId !== expected!.vaultId || latest.generation !== expected!.generation || latest.keyId !== expected!.keyId) throw new PairingEndedError('The vault changed. Start again.');
					await unlockVaultWithPairedKeys(this.plugin, latest, pairedBundle(result.payload), current);
					this.finished = true;
					await this.attempt.close(true).catch(() => {});
					new Notice('This vault is unlocked. Open the command palette and select Crate: Sync now.');
					this.plugin.refreshSettingsTab();
					this.close();
					void offerFeatureChoice(this.plugin);
					return;
				}
				if (result.code) {
					heading.setText('Compare codes');
					instructions.setText('Check that your desktop shows the same code, then select ');
					instructions.createEl('strong', { text: 'Approve' }); instructions.appendText(' there.');
				}
				this.timer = window.setTimeout(() => { void poll(); }, 2500);
			} catch (error) { showError(error); }
			finally { polling = false; }
		};
		void poll();
	}
	onClose(): void {
		if (!this.finished && this.attempt) void this.attempt.close().catch(() => {});
		this.controller.abort(); window.clearTimeout(this.timer);
		this.attempt = undefined;
		super.onClose();
	}
}

function pairedBundle(payload: unknown): VaultKeyBundle {
	const packet = payload as { bundle?: unknown } | null;
	if (!packet || typeof packet !== 'object' || Object.keys(packet).join() !== 'bundle') throw new Error('Invalid key transfer.');
	try { validateVaultKeyBundle(packet.bundle); } catch { throw new Error('Invalid key transfer.'); }
	return packet.bundle;
}
