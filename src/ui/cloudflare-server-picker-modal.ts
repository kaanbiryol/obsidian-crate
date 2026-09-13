import { Setting, type App } from 'obsidian';
import { SharedModal } from './shared/SharedModal';
import type { DiscoveredCloudflareDeployment } from '../cloudflare/deployment-discovery';

class CloudflareServerPickerModal extends SharedModal {
	private settled = false;

	constructor(
		app: App,
		private readonly deployments: DiscoveredCloudflareDeployment[],
		private readonly resolve: (deployment: DiscoveredCloudflareDeployment | 'create' | null) => void,
		private readonly missingServer = false,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('crate-cloudflare-server-picker-modal');
		this.openLayout(this.missingServer ? 'Your previous server is no longer available' : this.deployments.length ? 'Choose a server' : 'Create a server');
		this.bodyEl.createEl('p', {
			text: (this.missingServer ? 'Your previous server is gone. Choose another server or create a new one. ' : 'Select a server for this vault or create a new one. ') + ' Local files are kept. Syncing combines local and remote files; files with the same path may be updated. Review local and remote files before syncing.',
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
		new Setting(this.bodyEl)
			.setName('Create server')
			.setDesc('Create a separate Crate server in this account. Cloudflare usage charges may apply.')
			.addButton(button => button.setButtonText('Create server').onClick(() => this.finish('create')));
	}

	onClose(): void {
		super.onClose();
		if (!this.settled) {
			this.settled = true;
			this.resolve(null);
		}
	}

	private finish(deployment: DiscoveredCloudflareDeployment | 'create'): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(deployment);
		this.close();
	}
}

export function selectCloudflareServer(
	app: App,
	deployments: DiscoveredCloudflareDeployment[],
	missingServer = false,
): Promise<DiscoveredCloudflareDeployment | 'create' | null> {
	return new Promise(resolve => {
		new CloudflareServerPickerModal(app, deployments, resolve, missingServer).open();
	});
}
