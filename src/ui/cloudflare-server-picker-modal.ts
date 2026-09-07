import { Setting, type App } from 'obsidian';
import { SharedModal } from './shared/SharedModal';
import type { DiscoveredCloudflareDeployment } from '../cloudflare/deployment-discovery';

class CloudflareServerPickerModal extends SharedModal {
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
		this.openLayout('Choose a Crate server');
		this.bodyEl.createEl('p', {
			text: 'This Cloudflare account has more than one Crate server. Select the one for this vault.',
			cls: 'crate-cloudflare-server-picker-description',
		});

		for (const deployment of this.deployments) {
			const modified = deployment.modifiedOn
				? `Updated ${new Date(deployment.modifiedOn).toLocaleString()}`
				: 'Existing Cloudflare deployment';
			new Setting(this.bodyEl)
				.setName(deployment.metadata.workerName)
				.setDesc(modified)
				.addButton(button => button
					.setButtonText('Connect')
					.setCta()
					.onClick(() => this.finish(deployment)));
		}
	}

	onClose(): void {
		super.onClose();
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
