import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { startCloudflareDeployment } from '../../cloudflare/plugin-integration';
import { openConfirmationModal } from '../confirmation-modal';

export function renderServerResetSetting(containerEl: HTMLElement, plugin: CratePlugin): void {
	const saved = plugin.settings.cloudflareDeployment;
	if (!saved?.accountId || !saved.d1DatabaseId) return;
	const deployment = { ...saved };
	if (deployment.reset?.deleteOnly) return;

	if (!plugin.syncRuntime.isConfigured() && !deployment.reset) {
		if (deployment.lastDeployedVersion) return;
		new Setting(containerEl)
			.setName('Repair server')
			.setDesc('Finish a deployment without deleting remote data. Reconnect this device when setup finishes.')
			.addButton(button => button
				.setButtonText('Repair server')
				.onClick(() => { void startCloudflareDeployment(plugin, 'update'); }));
		return;
	}

	new Setting(containerEl)
		.setName('Rebuild server')
		.setDesc('Erase this Crate server’s remote files, history, database, and reminder state. Rebuild the server, then select Crate: Sync now to upload your local vault.')
		.addButton(button => button
			.setButtonText(deployment.reset ? 'Resume server rebuild' : 'Rebuild server')
			.setDestructive()
			.onClick(async () => {
				button.setDisabled(true);
				try {
					const confirmed = await openConfirmationModal(plugin.app, {
						title: deployment.reset ? 'Resume server rebuild' : 'Rebuild server',
						message: 'Permanently erase this Crate server’s remote data and rebuild it from scratch?',
						details: [
							`Account: ${deployment.accountName ?? deployment.accountId} (${deployment.accountId})`,
							`Server: ${deployment.workerName}`,
							`Database: ${deployment.d1DatabaseName} (${deployment.d1DatabaseId})`,
							`File bucket: ${deployment.r2BucketName}`,
							'All verified Crate remote files, retained versions, recovery history, device registrations, and push subscriptions will be erased.',
							'Your local files are kept. Confirm your local vault contains everything you want to upload again.',
							'This server’s database, file bucket, and reminder state are removed and recreated. Its Worker is temporarily taken offline and redeployed. Other deployments are not reset.',
							'Other devices must reconnect. Set up web push again. Select Crate: Sync now afterward to upload your local vault. No files are uploaded automatically.',
						],
						confirmText: 'Rebuild server',
						warning: true,
					});
					if (!confirmed) return;
					// The displayed resource identity is the one the user confirmed.
					if (JSON.stringify(plugin.settings.cloudflareDeployment) !== JSON.stringify(deployment)) {
						new Notice('Server settings changed. Open the rebuild confirmation again.');
						return;
					}
					await startCloudflareDeployment(plugin, 'reset');
				} finally {
					button.setDisabled(false);
				}
			}));
}
