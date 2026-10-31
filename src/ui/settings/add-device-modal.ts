import { createModalActions, createModalFooter, SharedModal } from '../plugin/shared-modal';
import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { captureServerConnection } from '../../plugin/server-request';
import { loadEncryptionKeys } from '../../sync/encryption/key-storage';
import { CloudflareReauthorizationRequired } from '../../cloudflare/oauth/client';
import { devicePairingLink } from '../../protocol/device-pairing';
import { errorMessage } from '../../platform/logger';
import { renderQrCode } from '../qr-modal';
import { WebAppPairingModal } from './web-app-pairing-modal';

/** Shows a one-use QR code for a new device, then hands over to key approval for an encrypted vault. */
export class AddDeviceModal extends SharedModal {
	private readonly controller = new AbortController();
	private timer?: number;
	constructor(private readonly plugin: CratePlugin) { super(plugin.app); }
	onOpen(): void {
		this.openLayout('Add a device');
		this.modalEl.addClass('crate-qr-modal');
		const status = this.bodyEl.createEl('p', { cls: 'crate-qr-desc', text: 'Creating a pairing code…', attr: { role: 'status', 'aria-live': 'polite' } });
		const actions = createModalFooter(this.contentEl);
		createModalActions(actions).addButton(button => button.setButtonText('Close').onClick(() => this.close()));
		const connection = captureServerConnection(this.plugin);
		const current = () => { this.controller.signal.throwIfAborted(); connection.assertCurrent(); };
		void (async () => {
			const issued = await this.plugin.cloudflareDeploymentService.issueDevicePairing(operation => this.plugin.cloudflareSavedLogin.withAuthorization(operation));
			current();
			const link = devicePairingLink(connection.origin, issued.code);
			status.setText('On your phone or other device:');
			const steps = this.bodyEl.createEl('ol', { cls: 'crate-qr-desc' });
			for (const step of ['Create an empty vault in Obsidian.', 'Turn on community plugins and install Crate.', 'Scan this code with the camera, or open the link.']) steps.createEl('li', { text: step });
			renderQrCode(this.bodyEl.createDiv({ cls: 'crate-qr-wrapper' }), link);
			const expiry = this.bodyEl.createEl('p', { cls: 'setting-item-description' });
			const fallback = this.bodyEl.createDiv({ cls: 'crate-qr-link-fallback' });
			fallback.hide();
			actions.empty();
			createModalActions(actions)
				.addButton(button => button.setButtonText('Copy link').onClick(async () => {
					try { await navigator.clipboard.writeText(link); new Notice('Pairing link copied'); }
					catch {
						fallback.empty(); fallback.show();
						new Setting(fallback).setName('Copy this link').addTextArea(text => { text.setValue(link); text.inputEl.readOnly = true; text.inputEl.focus(); });
					}
				}))
				.addButton(button => button.setButtonText('Close').onClick(() => this.close()));
			const api = this.plugin.syncRuntime.getApiClient();
			const poll = async () => {
				if (this.controller.signal.aborted) return;
				const remaining = issued.expiresAt - Date.now();
				if (remaining <= 0) { expiry.setText('This code expired. Close this window and add the device again.'); return; }
				expiry.setText(`This one-use code expires in ${Math.ceil(remaining / 60_000)} min.`);
				try {
					const device = (await api?.listTokens())?.tokens.find(token => token.id === issued.tokenId);
					current();
					if (device) { this.connected(device.device_name ?? 'New device'); return; }
				} catch (error) { if (this.controller.signal.aborted) return; expiry.setText(`Checking for the new device failed: ${errorMessage(error)}`); }
				this.timer = window.setTimeout(() => { void poll(); }, 2500);
			};
			await poll();
		})().catch(error => {
			if (this.controller.signal.aborted) return;
			status.setText(error instanceof CloudflareReauthorizationRequired
				? 'Your Cloudflare login needs renewing. Select Reconnect under Account and devices, then try again.'
				: `Couldn’t create a pairing code: ${errorMessage(error)}`);
		});
	}
	private connected(name: string): void {
		// The new device asks for keys right after it connects; approval happens here.
		if (loadEncryptionKeys(this.plugin.secretStorage)) {
			this.close();
			new WebAppPairingModal(this.plugin, 'device').open();
			return;
		}
		this.bodyEl.empty();
		this.bodyEl.createEl('p', { cls: 'crate-qr-desc', text: `${name} is connected. Sync it with Crate: Sync now from its command palette.` });
		this.plugin.refreshSettingsTab();
	}
	onClose(): void {
		this.controller.abort(); window.clearTimeout(this.timer);
		super.onClose();
	}
}
