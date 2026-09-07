import { renderServerDeleteSetting } from './server-delete-setting';
import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { startCloudflareDeployment } from '../../cloudflare/plugin-integration';
import { openConfirmationModal } from '../confirmation-modal';

export function renderServerResetSetting(containerEl: HTMLElement, plugin: CratePlugin): void {
	const saved = plugin.settings.cloudflareDeployment;
	if (!saved?.accountId || !saved.d1DatabaseId) return;
	const deployment = { ...saved };
	if (deployment.reset?.deleteOnly) {
		renderServerDeleteSetting(containerEl, plugin);
		return;
	}

	new Setting(containerEl)
		.setName('Reset server')
		.setDesc('Erase this Crate server’s remote files, history, database, and reminder state. Rebuild the server and upload your local vault afterward.')
		.addButton(button => button
			.setButtonText(deployment.reset ? 'Resume server reset' : 'Reset server')
			.setDestructive()
			.onClick(async () => {
				button.setDisabled(true);
				try {
					const confirmed = await openConfirmationModal(plugin.app, {
						title: deployment.reset ? 'Resume server reset' : 'Reset server',
						message: 'Permanently erase this Crate server’s remote data and rebuild it from scratch?',
						details: [
							`Account: ${deployment.accountName ?? deployment.accountId} (${deployment.accountId})`,
							`Server: ${deployment.workerName}`,
							`Database: ${deployment.d1DatabaseName} (${deployment.d1DatabaseId})`,
							`File bucket: ${deployment.r2BucketName}`,
							'All verified Crate remote files, retained versions, recovery history, device registrations, and push subscriptions will be erased.',
							'Your local files are kept. Confirm your local vault contains everything you want to upload again.',
							'This server’s database, file bucket, and reminder state are removed and recreated. Its Worker is temporarily taken offline and redeployed. Other deployments are not reset.',
							'Other devices must reconnect. Set up web push again. No files are uploaded automatically.',
						],
						confirmText: 'Authorize server reset',
						warning: true,
					});
					if (!confirmed) return;
					// The displayed resource identity is the one the user confirmed.
					if (JSON.stringify(plugin.settings.cloudflareDeployment) !== JSON.stringify(deployment)) {
						new Notice('Server settings changed. Open the reset confirmation again.');
						return;
					}
					await startCloudflareDeployment(plugin, 'reset');
				} finally {
					button.setDisabled(false);
				}
			}));

	if (!plugin.syncRuntime.isConfigured() && !deployment.reset) {
		new Setting(containerEl)
			.setName('Repair server')
			.setDesc('Finish a deployment without deleting remote data. Reconnect this device when setup finishes.')
			.addButton(button => button
				.setButtonText('Repair server')
				.onClick(() => { void startCloudflareDeployment(plugin, 'update'); }));
	}
	renderServerDeleteSetting(containerEl, plugin);
}
