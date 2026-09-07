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
