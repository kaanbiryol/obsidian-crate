import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	MockModal,
	createObsidianUiModule,
	resetObsidianUiMocks,
} from '../test/fakes/obsidian-ui';

const unmount = vi.fn();
vi.mock('react-dom/client', () => ({
	createRoot: (element: { textContent: string }) => ({
		render: (node: ReactNode) => { element.textContent = renderToStaticMarkup(node); },
		unmount,
	}),
}));

afterEach(() => {
	resetObsidianUiMocks();
	unmount.mockClear();
	vi.resetModules();
	vi.doUnmock('obsidian');
});

describe('CloudflareDeploymentModal', () => {
	it('keeps Cloudflare setup progress visible after Obsidian regains focus', async () => {
		vi.doMock('obsidian', () => createObsidianUiModule());
		const { openCloudflareDeploymentModal } = await import('./cloudflare-deployment-modal');

		const modal = openCloudflareDeploymentModal({} as never);
		expect(MockModal.instances).toHaveLength(1);
		expect(MockModal.instances[0]?.titleEl.textContent).toBe('Setting up Crate');
		expect(MockModal.instances[0]?.contentEl.collectText()).toContain('Finding your Crate server in Cloudflare');

		modal.setWorking('Connecting this device', 'Creating a private credential for this device.');
		expect(MockModal.instances[0]?.titleEl.textContent).toBe('Connecting this device');
		expect(MockModal.instances[0]?.contentEl.collectText()).toContain('Creating a private credential');

		modal.succeed('Crate is ready', 'This device is connected.');
		expect(MockModal.instances[0]?.contentEl.collectText()).toContain('Done');

		modal.fail('Finish connecting your server', 'This server was already claimed.', ['Wait and try again.']);
		expect(MockModal.instances[0]?.titleEl.textContent).toBe('Finish connecting your server');
		expect(MockModal.instances[0]?.contentEl.collectText()).toContain('This server was already claimed.');
		expect(MockModal.instances[0]?.contentEl.collectText()).toContain('Wait and try again.');
	});

	it('shows technical details separately and releases the React root on close', async () => {
		vi.doMock('obsidian', () => createObsidianUiModule());
		const { openCloudflareDeploymentModal } = await import('./cloudflare-deployment-modal');
		const modal = openCloudflareDeploymentModal({} as never);
		modal.fail('Server reset failed', 'Could not finish the reset.', ['Open settings to try again.'], {
			technicalDetails: 'Namespace listing incomplete',
			action: { label: 'Open settings', onClick: vi.fn() },
		});
		const markup = MockModal.instances[0]!.contentEl.collectText();
		expect(markup).toContain('reminder-modal-header');
		expect(markup).toContain('<summary>Technical details</summary>');
		expect(markup).toContain('Namespace listing incomplete');
		expect(markup).toContain('Open settings');
		expect(markup).not.toContain('<ul');
		modal.close();
		expect(unmount).toHaveBeenCalledOnce();
		modal.succeed('Finished later', 'Should stay closed.');
		expect(MockModal.instances[0]!.contentEl.collectText()).toBe('');
	});

	it('uses update-specific progress copy for an existing server', async () => {
		vi.doMock('obsidian', () => createObsidianUiModule());
		const { openCloudflareDeploymentModal } = await import('./cloudflare-deployment-modal');

		openCloudflareDeploymentModal({} as never, 'update');

		expect(MockModal.instances[0]?.titleEl.textContent).toBe('Updating Cloudflare server');
		expect(MockModal.instances[0]?.contentEl.collectText()).toContain(
			'Preparing your Worker and web app update',
		);
	});
});

it('replaces progress with vault selection in the same modal and settles on close', async () => {
	vi.doMock('obsidian', () => createObsidianUiModule());
	const { openCloudflareDeploymentModal } = await import('./cloudflare-deployment-modal');
	const modal = openCloudflareDeploymentModal({} as never);
	modal.setWorking('Setting up Crate', 'Checking your Cloudflare account…');
	const selected = modal.selectVault([], true);
	expect(MockModal.instances).toHaveLength(1);
	const host = MockModal.instances[0]!;
	expect(host.titleEl.textContent).toBe('Your previous server is no longer available');
	expect(host.contentEl.collectText()).toContain('Create server');
	expect(host.contentEl.collectText()).not.toContain('Checking your Cloudflare account');
	modal.close();
	await expect(selected).resolves.toBeNull();
	await expect(modal.selectVault([])).resolves.toBeNull();
});

it('attaches the dialog to the settings document even when another window is active', async () => {
	vi.doMock('obsidian', () => createObsidianUiModule());
	const { openCloudflareDeploymentModal } = await import('./cloudflare-deployment-modal');
	const focus = vi.fn();
	const container = { querySelector: () => ({ focus }) };
	Object.defineProperty(MockModal.prototype, 'containerEl', { configurable: true, get: () => container });
	try {
		const host = { body: { appendChild: vi.fn() }, defaultView: { focus: vi.fn() } };
		openCloudflareDeploymentModal({} as never, 'setup', host as never);
		expect(host.body.appendChild).toHaveBeenCalledWith(container);
		expect(host.defaultView.focus).toHaveBeenCalledOnce();
		expect(focus).toHaveBeenCalledOnce();
	} finally {
		Reflect.deleteProperty(MockModal.prototype, 'containerEl');
	}
});

it('does not confuse Obsidian’s saved editor selection with the vault picker state', async () => {
	vi.doMock('obsidian', () => createObsidianUiModule());
	const { openCloudflareDeploymentModal } = await import('./cloudflare-deployment-modal');
	const open = vi.spyOn(MockModal.prototype, 'open').mockImplementation(function (this: MockModal) {
		// Obsidian sets its internal selection while opening a modal.
		Object.assign(this, { selection: { anchor: 0, head: 0 } });
		MockModal.instances.push(this);
		void this.onOpen();
	});
	try {
		const modal = openCloudflareDeploymentModal({} as never);
		expect(MockModal.instances[0]?.titleEl.textContent).toBe('Setting up Crate');
		const pending = modal.selectVault([], true);
		expect(MockModal.instances[0]?.titleEl.textContent).toBe('Your previous server is no longer available');
		modal.close();
		await expect(pending).resolves.toBeNull();
	} finally {
		open.mockRestore();
	}
});


it('shows the saved vault name in the setup picker', async () => {
	vi.doMock('obsidian', () => createObsidianUiModule());
	const { openCloudflareDeploymentModal } = await import('./cloudflare-deployment-modal');
	const modal = openCloudflareDeploymentModal({} as never);
	const selected = modal.selectVault([{
		metadata: { vaultName: 'Notes', workerName: 'crate-0123456789abcdef', deploymentId: '0123456789abcdef' },
		modifiedOn: null,
	}] as never);
	const markup = MockModal.instances[0]!.contentEl.collectText();
	expect(markup).toContain('>Notes</button>');
	expect(markup).not.toContain('>crate-0123456789abcdef</button>');
	modal.close();
	await expect(selected).resolves.toBeNull();
});
