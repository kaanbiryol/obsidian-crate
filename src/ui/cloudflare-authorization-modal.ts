import type { App } from 'obsidian';
import { SharedModal } from './shared/SharedModal';

const activeAuthorization = new WeakMap<App, CloudflareAuthorizationModal>();

class CloudflareAuthorizationModal extends SharedModal {
	private readonly onAbort = () => this.close();

	constructor(app: App, private readonly url: string, private readonly signal: AbortSignal) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('crate-cloudflare-authorization-modal');
		this.openLayout('Sign in with Cloudflare');
		this.bodyEl.createEl('p', {
			text: 'Use the link below to open Cloudflare in your browser. Return to Obsidian after authorizing Crate.',
		});
		const link = this.bodyEl.createEl('a', {
			text: 'Open Cloudflare',
			cls: 'external-link crate-cloudflare-authorization-link',
		});
		link.setAttribute('href', this.url);
		link.setAttribute('target', '_blank');
		link.setAttribute('rel', 'noopener noreferrer');
		this.bodyEl.createEl('p', {
			text: 'If Obsidian does not reopen automatically, use the callback page button to return.',
			cls: 'crate-cloudflare-authorization-help',
		});
		this.signal.addEventListener('abort', this.onAbort, { once: true });
		if (this.signal.aborted) this.close();
	}

	onClose(): void {
		this.signal.removeEventListener('abort', this.onAbort);
		if (activeAuthorization.get(this.app) === this) activeAuthorization.delete(this.app);
		super.onClose();
	}
}

export function openCloudflareAuthorizationModal(app: App, url: string, signal: AbortSignal): void {
	activeAuthorization.get(app)?.close();
	const modal = new CloudflareAuthorizationModal(app, url, signal);
	activeAuthorization.set(app, modal);
	modal.open();
}

export function dismissCloudflareAuthorizationModal(app: App): void {
	activeAuthorization.get(app)?.close();
}
