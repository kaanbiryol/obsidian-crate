import { Notice, Setting, type TextComponent } from 'obsidian';
import { connectSelfHostedServer, updateSelfHostedServerAddress } from '../../sync/self-hosted-connection';
import type { ConfigSectionContext } from './config-types';
import { createSettingsDisclosure } from './section-helpers';
import { selfHostedConnectionMessage } from './self-hosted-errors';

export function renderSelfHostedAddressSetting({ containerEl, plugin, rerender }: ConfigSectionContext): void {
	if (!plugin.syncRuntime.isConfigured() || plugin.settings.cloudflareDeployment) return;
	let address = plugin.settings.workerUrl;
	let errorEl: HTMLElement;
	new Setting(containerEl).setName('Update server address')
		.setDesc('After restarting a temporary tunnel, paste its new HTTPS address. Your saved access token is reused. Sync again after updating.')
		.addText(input => input.setValue(address).setPlaceholder('https://…trycloudflare.com').onChange(value => { address = value; }))
		.addButton(button => button.setButtonText('Update address').onClick(async () => {
			button.setDisabled(true);
			errorEl.hidden = true;
			try {
				await updateSelfHostedServerAddress(plugin, address);
				new Notice('Server address updated. Sync your vault, then create a new link to enroll the web app.');
				rerender();
			} catch (error) {
				errorEl.setText(selfHostedConnectionMessage(error, address));
				errorEl.hidden = false;
			}
			finally { button.setDisabled(false); }
		}));
	errorEl = containerEl.createEl('p', { cls: 'setting-item-description', attr: { role: 'alert', 'aria-live': 'polite' } });
	errorEl.hidden = true;
}

export function renderSelfHostedSetting({ containerEl, plugin, rerender }: ConfigSectionContext): void {
	if (plugin.syncRuntime.isConfigured() || plugin.settings.cloudflareDeployment) return;
	const container = createSettingsDisclosure(containerEl, 'Connect to your server');
	let address = '';
	let token = '';
	let addressInput: TextComponent;
	let tokenInput: TextComponent;
	let errorEl: HTMLElement;
	new Setting(container).setName('Server address')
		.setDesc('Paste the HTTPS address printed in your server logs. Use localhost only for a local-only server on this device.')
		.addText(input => {
			addressInput = input;
			input.setValue(address).setPlaceholder('https://crate.example.com').onChange(value => { address = value; });
		});
	new Setting(container).setName('Pairing code or access token')
		.setDesc('Paste the single-use pairing code from your server. An existing device access token also works. Credentials are saved in Obsidian secret storage.')
		.addText(input => {
			tokenInput = input;
			input.inputEl.type = 'password';
			input.inputEl.autocomplete = 'off';
			input.onChange(value => { token = value; });
		});
	new Setting(container).setName('Connect to your server')
		.setDesc('All devices using this server share one vault. Start syncing after connecting.')
		.addButton(button => button.setButtonText('Connect').setCta().onClick(async () => {
			errorEl.hidden = true;
			button.setDisabled(true).setButtonText('Connecting…');
			addressInput.setDisabled(true);
			tokenInput.setDisabled(true);
			try {
				await connectSelfHostedServer(plugin, address, token);
				token = '';
				tokenInput.setValue('');
				new Notice('Connected to your server. You can now sync this vault.');
				rerender();
			} catch (error) {
				errorEl.setText(selfHostedConnectionMessage(error, address));
				errorEl.hidden = false;
			} finally {
				button.setDisabled(false).setButtonText('Connect');
				addressInput.setDisabled(false);
				tokenInput.setDisabled(false);
			}
		}));
	errorEl = container.createEl('p', { cls: 'setting-item-description', attr: { role: 'alert', 'aria-live': 'polite' } });
	errorEl.hidden = true;
}
