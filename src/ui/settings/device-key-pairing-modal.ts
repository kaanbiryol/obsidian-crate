import { createModalActions, createModalFooter, SharedModal } from '../plugin/shared-modal';
import { Notice, type Setting } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { offerFeatureChoice } from '../../plugin/feature-settings';
import { startVaultReplacement } from '../../plugin/sync-integration';
import { openDeviceKeyRequest } from '../../plugin/web-app-pairing';
import { PairingEndedError } from '../../encryption/pairing/protocol';

/** Asks a device that holds the vault keys to send them, after both screens show the same code. */
export class DeviceKeyPairingModal extends SharedModal {
	private readonly controller = new AbortController();
	private timer?: number;
	private attempt?: Awaited<ReturnType<ReturnType<typeof openDeviceKeyRequest>['start']>>;
	private finished = false;
	constructor(private readonly plugin: CratePlugin) { super(plugin.app); }
	onOpen(): void {
		this.openLayout('Unlock this vault');
		this.modalEl.addClass('crate-encryption-modal', 'crate-web-pairing-modal');
		const status = this.bodyEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
		const heading = status.createEl('h3', { cls: 'crate-encryption-operation__title', text: 'Waiting for your desktop…' });
		const instructions = status.createEl('p', { cls: 'crate-encryption-intro', text: 'This vault is encrypted. On an unlocked device, keep ' });
		instructions.createEl('strong', { text: 'Add a device' }); instructions.appendText(' open or select ');
		instructions.createEl('strong', { text: 'Manage encryption' }); instructions.appendText(' → ');
		instructions.createEl('strong', { text: 'Connect web app' }); instructions.appendText(' to approve this device.');
		const codePanel = this.bodyEl.createDiv({ cls: 'crate-web-pairing-verification' });
		codePanel.createSpan({ text: 'Verification code' });
		const code = codePanel.createEl('output', { cls: 'crate-web-pairing-code', attr: { 'aria-label': 'Verification code' } });
		codePanel.hidden = true;
		const actions = createModalFooter(this.contentEl);
		actions.addClass('crate-encryption-footer');
		const addCancel = (setting: Setting) => setting.addButton(button => button.setButtonText('Cancel').onClick(() => this.close()));
		addCancel(createModalActions(actions));

		const request = openDeviceKeyRequest(this.plugin, this.controller.signal);
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
			window.clearTimeout(this.timer);
			if (document.hidden) { this.timer = window.setTimeout(() => { void poll(); }, 2500); return; }
			polling = true;
			try {
				this.attempt ??= await request.start();
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
					await request.unlock(result.payload);
					this.finished = true;
					await this.attempt.close(true).catch(() => {});
					this.plugin.refreshSettingsTab();
					this.close();
					const plugin = this.plugin;
					void offerFeatureChoice(plugin).finally(() => {
						if (!startVaultReplacement(plugin)) new Notice('This vault is unlocked. Open the command palette and select Crate: Sync now.');
					});
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
