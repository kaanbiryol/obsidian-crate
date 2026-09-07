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
		this.root?.unmount();
		this.root = undefined;
		this.contentEl.empty();
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
): CloudflareDeploymentModal {
	const modal = new CloudflareDeploymentModal(app, mode);
	modal.open();
	return modal;
}
