import { vaultChoiceLabel } from '../cloudflare/vault-name';
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
		this.openLayout(this.missingServer ? 'Server unavailable' : this.deployments.length ? 'Choose a server' : 'Create a server');
		this.bodyEl.createEl('p', {
			text: this.missingServer
				? 'Your previous server is no longer available. Choose another server or create a new one.'
				: this.deployments.length ? 'Select a server for this vault or create a new one.' : 'Create a Cloudflare server for this vault.',
			cls: 'crate-cloudflare-server-picker-description',
		});
		this.bodyEl.createEl('p', {
			text: this.deployments.length
				? 'Local files stay unchanged during setup. Syncing combines local and remote files and may update matching paths. Review both before syncing.'
				: 'Local files stay unchanged during setup. When ready, run Crate: Sync now from the command palette.',
			cls: 'crate-cloudflare-server-picker-help',
		});

		for (const deployment of this.deployments) {
			const modified = deployment.modifiedOn
				? `Updated ${new Date(deployment.modifiedOn).toLocaleString()}`
				: 'Existing Cloudflare deployment';
			new Setting(this.bodyEl)
				.setName(vaultChoiceLabel(deployment.metadata, this.deployments.map(item => item.metadata)))
				.setDesc(modified)
				.addButton(button => button
					.setButtonText('Connect')
					.setCta()
					.onClick(() => this.finish(deployment)));
		}
		new Setting(this.bodyEl)
			.setName('New server')
			.setDesc('Create a separate Crate server in this account. Cloudflare usage charges may apply.')
			.addButton(button => {
				button.setButtonText('Create server').onClick(() => this.finish('create'));
				if (!this.deployments.length) button.setCta();
			});
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
