import { Modal, Setting, type App } from 'obsidian';
import type { DiscoveredCloudflareDeployment } from '../cloudflare/deployment-discovery';

class CloudflareServerPickerModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly deployments: DiscoveredCloudflareDeployment[],
		private readonly resolve: (deployment: DiscoveredCloudflareDeployment | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('crate-cloudflare-server-picker-modal');
		this.setTitle('Choose a Crate server');
		this.contentEl.createEl('p', {
			text: 'This Cloudflare account has more than one Crate server. Select the one for this vault.',
			cls: 'crate-cloudflare-server-picker-description',
		});

		for (const deployment of this.deployments) {
			const modified = deployment.modifiedOn
				? `Updated ${new Date(deployment.modifiedOn).toLocaleString()}`
				: 'Existing Cloudflare deployment';
			new Setting(this.contentEl)
				.setName(deployment.metadata.workerName)
				.setDesc(modified)
				.addButton(button => button
					.setButtonText('Connect')
					.setCta()
					.onClick(() => this.finish(deployment)));
		}
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolve(null);
		}
	}

	private finish(deployment: DiscoveredCloudflareDeployment): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(deployment);
		this.close();
	}
}

export function selectCloudflareServer(
	app: App,
	deployments: DiscoveredCloudflareDeployment[],
): Promise<DiscoveredCloudflareDeployment | null> {
	return new Promise(resolve => {
		new CloudflareServerPickerModal(app, deployments, resolve).open();
	});
}
