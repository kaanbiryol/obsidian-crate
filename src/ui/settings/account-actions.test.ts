import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';

const confirm = vi.fn();
beforeEach(() => { resetObsidianUiMocks(); confirm.mockReset(); });
afterEach(() => { vi.resetModules(); vi.doUnmock('obsidian'); vi.doUnmock('../confirmation-modal'); });

async function render() {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../confirmation-modal', () => ({ openConfirmationModal: confirm }));
	const { renderAccountActions } = await import('./account-actions');
	const plugin = {
		app: {}, settings: { workerUrl: 'https://example.com', cloudflareDeployment: { accountId: 'account' } },
		cloudflareUsageConnection: { connected: true, disconnect: vi.fn(async () => {}) },
		cloudflareDeploymentService: { cancelPendingDeployment: vi.fn() },
	};
	const rerender = vi.fn();
	renderAccountActions(new FakeElement('div') as never, plugin as never, rerender);
	const button = MockSetting.instances.find(setting => setting.nameEl.textContent === 'Cloudflare login')!.buttons[0]!;
	return { plugin, button, rerender };
}

it('only removes the Cloudflare login after confirmation, keeping server selection', async () => {
	const { plugin, button, rerender } = await render();
	confirm.mockResolvedValue(true);
	button.click();
	await vi.waitFor(() => expect(rerender).toHaveBeenCalledOnce());
	expect(plugin.cloudflareUsageConnection.disconnect).toHaveBeenCalledOnce();
	expect(plugin.settings.workerUrl).toBe('https://example.com');
	expect(plugin.settings.cloudflareDeployment.accountId).toBe('account');
});

it('keeps the login when sign-out is cancelled', async () => {
	const { plugin, button } = await render();
	confirm.mockResolvedValue(false);
	button.click();
	await Promise.resolve();
	expect(plugin.cloudflareUsageConnection.disconnect).not.toHaveBeenCalled();
});

it('keeps the login while a deployment is active', async () => {
	const { plugin, button, rerender } = await render();
	confirm.mockResolvedValue(true);
	plugin.cloudflareDeploymentService.cancelPendingDeployment.mockImplementation(() => { throw new Error('Deployment in progress'); });
	button.click();
	await vi.waitFor(() => expect(rerender).toHaveBeenCalledOnce());
	expect(plugin.cloudflareUsageConnection.disconnect).not.toHaveBeenCalled();
});

it('does not sign out a different account selected during confirmation', async () => {
	const { plugin, button } = await render();
	confirm.mockImplementation(async () => { plugin.settings.cloudflareDeployment.accountId = 'other'; return true; });
	button.click();
	await Promise.resolve();
	expect(plugin.cloudflareUsageConnection.disconnect).not.toHaveBeenCalled();
});
