import { Modal, setIcon, type App } from 'obsidian';

type DeploymentProgressState = 'working' | 'success' | 'error';
export type CloudflareDeploymentMode = 'setup' | 'update';

interface DeploymentProgressContent {
	state: DeploymentProgressState;
	title: string;
	description: string;
	details?: string[];
}

/**
 * Keeps the Cloudflare hand-off visible after the browser returns to Obsidian.
 * OAuth and Worker provisioning can take long enough that a transient notice is
 * easy to miss, especially when Obsidian regains focus in the background.
 */
export class CloudflareDeploymentModal extends Modal {
	private content: DeploymentProgressContent;
	private closed = false;

	constructor(app: App, mode: CloudflareDeploymentMode = 'setup') {
		super(app);
		this.content = mode === 'update'
			? {
				state: 'working',
				title: 'Updating Cloudflare server',
				description: 'Preparing your Worker and web app update. This usually takes less than a minute.',
			}
			: {
				state: 'working',
				title: 'Setting up Crate',
				description: 'Finding your Crate server in Cloudflare. This usually takes less than a minute.',
			};
	}

	onOpen(): void {
		this.modalEl.addClass('crate-cloudflare-deployment-modal');
		this.render();
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}

	setWorking(title: string, description: string): void {
		this.update({ state: 'working', title, description });
	}

	succeed(title: string, description: string): void {
		this.update({ state: 'success', title, description });
	}

	fail(title: string, description: string, details?: string[]): void {
		this.update({ state: 'error', title, description, details });
	}

	private update(content: DeploymentProgressContent): void {
		this.content = content;
		if (!this.closed) {
			this.render();
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.content.title);

		const body = contentEl.createDiv({ cls: 'crate-cloudflare-deployment-content' });
		body.setAttribute('role', 'status');
		body.setAttribute('aria-live', 'polite');
		body.setAttribute('aria-busy', this.content.state === 'working' ? 'true' : 'false');

		const status = body.createDiv({ cls: 'crate-cloudflare-deployment-status' });
		const icon = status.createDiv({ cls: 'crate-cloudflare-deployment-icon' });
		icon.addClass(`is-${this.content.state}`);
		setIcon(icon, this.iconName());

		const copy = status.createDiv({ cls: 'crate-cloudflare-deployment-copy' });
		copy.createEl('p', {
			text: this.content.description,
			cls: 'crate-cloudflare-deployment-description',
		});

		if (this.content.details?.length) {
			const details = copy.createEl('ul', { cls: 'crate-cloudflare-deployment-details' });
			for (const detail of this.content.details) {
				details.createEl('li', { text: detail });
			}
		}

		if (this.content.state !== 'working') {
			const actions = body.createDiv({ cls: 'crate-cloudflare-deployment-actions' });
			const closeButton = actions.createEl('button', {
				text: this.content.state === 'success' ? 'Done' : 'Close',
				cls: 'mod-cta',
			});
			closeButton.addEventListener('click', () => this.close());
		}
	}

	private iconName(): string {
		switch (this.content.state) {
			case 'success':
				return 'circle-check';
			case 'error':
				return 'triangle-alert';
			case 'working':
			default:
				return 'loader-circle';
		}
	}
}

export function openCloudflareDeploymentModal(
	app: App,
	mode: CloudflareDeploymentMode = 'setup',
): CloudflareDeploymentModal {
	const modal = new CloudflareDeploymentModal(app, mode);
	modal.open();
	return modal;
}
