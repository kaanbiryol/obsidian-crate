import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	MockModal,
	createObsidianUiModule,
	resetObsidianUiMocks,
} from '../test/fakes/obsidian-ui';

afterEach(() => {
	resetObsidianUiMocks();
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
});
