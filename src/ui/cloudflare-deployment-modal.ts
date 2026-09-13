import type { DiscoveredCloudflareDeployment } from '../cloudflare/deployment-discovery';
import { Modal, type App } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModalLayout } from './shared/ModalLayout';
import { StatusContent } from './shared/StatusContent';
import { Button } from './shared/Button';
import { ThemeIconProvider } from '../reminders/components/theme-icon';
import { ObsidianIcon } from '../reminders/components/obsidian-icon';

type DeploymentProgressState = 'working' | 'success' | 'error';
export type CloudflareDeploymentMode = 'setup' | 'update';

interface FailureOptions {
	technicalDetails?: string;
	action?: { label: string; onClick: () => void };
}

interface DeploymentProgressContent extends FailureOptions {
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
	private root: Root | undefined;
	private vaultSelection?: { deployments: DiscoveredCloudflareDeployment[]; missing: boolean; resolve: (value: DiscoveredCloudflareDeployment | 'create' | null) => void };

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
		this.closed = false;
		this.modalEl.addClass('crate-cloudflare-deployment-modal');
		this.modalEl.addClass('crate-custom-modal-close');
		this.contentEl.addClass('crate-reminders-ui');
		this.root = createRoot(this.contentEl);
		this.render();
	}

	onClose(): void {
		this.closed = true;
		this.vaultSelection?.resolve(null);
		this.vaultSelection = undefined;
		this.root?.unmount();
		this.root = undefined;
		this.contentEl.empty();
	}

	selectVault(deployments: DiscoveredCloudflareDeployment[], missing = false): Promise<DiscoveredCloudflareDeployment | 'create' | null> {
		if (this.closed) return Promise.resolve(null);
		return new Promise(resolve => {
			this.vaultSelection = { deployments, missing, resolve };
			this.render();
		});
	}

	private finishSelection(value: DiscoveredCloudflareDeployment | 'create'): void {
		const selection = this.vaultSelection;
		this.vaultSelection = undefined;
		this.setWorking('Setting up Crate', 'Preparing the selected server…');
		selection?.resolve(value);
	}

	setWorking(title: string, description: string): void {
		this.update({ state: 'working', title, description });
	}

	succeed(title: string, description: string): void {
		this.update({ state: 'success', title, description });
	}

	fail(title: string, description: string, details?: string[], options?: FailureOptions): void {
		this.update({ state: 'error', title, description, details, ...options });
	}

	private update(content: DeploymentProgressContent): void {
		this.content = content;
		if (!this.closed) {
			this.render();
		}
	}

	private render(): void {
		if (this.vaultSelection) {
			const { deployments, missing } = this.vaultSelection;
			const title = missing ? 'Your previous server is no longer available' : deployments.length ? 'Choose a server' : 'Create a server';
			this.modalEl.removeClass('is-working');
			this.setTitle(title);
			this.root?.render(createElement(ThemeIconProvider, { renderer: ObsidianIcon, children: createElement(ModalLayout, {
				title, onClose: () => this.close(),
				children: createElement('div', { className: 'crate-vault-selection' },
					createElement('p', null, missing ? 'Your previous server is gone. Choose another server or create a new one.' : 'Select a server for this vault or create a new one.'),
					createElement('p', null, 'Local files are kept. Syncing combines local and remote files; files with the same path may be updated. No files are synced automatically.'),
					...deployments.map(deployment => createElement(Button, {
						key: deployment.metadata.workerName,
						onClick: () => this.finishSelection(deployment), children: deployment.metadata.workerName,
					})),
					createElement('p', null, 'Creating a server may incur Cloudflare usage charges.'),
				),
				footer: createElement('div', { className: 'crate-status-actions' },
					createElement(Button, { onClick: () => this.close(), children: 'Cancel' }),
					createElement(Button, { className: 'mod-cta', onClick: () => this.finishSelection('create'), children: 'Create server' })),
			}) }));
			return;
		}
		this.modalEl.toggleClass('is-working', this.content.state === 'working');
		this.setTitle(this.content.title);
		const action = this.content.action;
		const footer = this.content.state === 'working' ? undefined : createElement('div', { className: 'crate-status-actions' },
			createElement(Button, {
				onClick: () => this.close(),
				children: this.content.state === 'success' ? 'Done' : 'Close',
			}),
			action && createElement(Button, {
				className: 'mod-cta',
				onClick: () => { this.close(); action.onClick(); },
				children: action.label,
			}),
		);
		this.root?.render(createElement(ThemeIconProvider, { renderer: ObsidianIcon, children: createElement(ModalLayout, {
			title: this.content.title,
			onClose: () => this.close(),
			footer,
			children: createElement(StatusContent, this.content),
		}) }));
	}

}

export function openCloudflareDeploymentModal(
	app: App,
	mode: CloudflareDeploymentMode = 'setup',
	hostDocument?: Document,
): CloudflareDeploymentModal {
	const modal = new CloudflareDeploymentModal(app, mode);
	modal.open();
	// OAuth may return to a different window than the detached Settings window.
	// Place the complete modal in its intended document instead of waiting for
	// activeWindow or animation frames, which can pause in background windows.
	if (hostDocument) {
		hostDocument.body.appendChild(modal.containerEl);
		hostDocument.defaultView?.focus();
		modal.containerEl.querySelector<HTMLElement>('button')?.focus();
	}
	return modal;
}
