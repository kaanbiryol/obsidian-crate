import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';

const confirm = vi.fn<(_app: unknown, options: { warning?: boolean; details: string[] }) => Promise<boolean>>();
const start = vi.fn();

async function render(configured = true, resetting = false, deployed = false) {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../../cloudflare/plugin-integration', () => ({ startCloudflareDeployment: start }));
	vi.doMock('../confirmation-modal', () => ({ openConfirmationModal: confirm }));
	const { renderServerResetSetting } = await import('./server-reset-setting');
	const plugin = {
		app: {},
		settings: { cloudflareDeployment: {
			lastDeployedVersion: deployed ? '0.1.0' : null,
			deploymentId: '0123456789abcdef', accountId: 'a'.repeat(32), accountName: 'Personal',
			workerName: 'crate-0123456789abcdef', d1DatabaseName: 'crate-0123456789abcdef',
			d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef', r2BucketName: 'crate-0123456789abcdef',
			...(resetting ? { reset: { id: 'r', phase: 'clearing', databaseId: 'd', bucketCreatedAt: 'date', namespaceId: 'n' } } : {}),
		} },
		syncRuntime: { isConfigured: () => configured },
	};
	renderServerResetSetting(new FakeElement('div') as never, plugin as never);
	return plugin;
}

beforeEach(() => { resetObsidianUiMocks(); confirm.mockReset(); start.mockReset(); });
afterEach(() => {
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../cloudflare/plugin-integration');
	vi.doUnmock('../confirmation-modal');
});

describe('server reset settings', () => {
	it('shows the exact target and consequences before starting reset authorization', async () => {
		const plugin = await render();
		confirm.mockResolvedValue(true);
		MockSetting.instances[0]!.buttons[0]!.click();
		await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith(plugin, 'reset'));
		const options = confirm.mock.calls[0]![1];
		expect(options.warning).toBe(true);
		expect(options.details.join(' ')).toContain(plugin.settings.cloudflareDeployment.d1DatabaseId);
		expect(options.details.join(' ')).toContain(plugin.settings.cloudflareDeployment.accountId);
		expect(options.details.join(' ')).toContain('recovery history');
		expect(options.details.join(' ')).toContain('local files are kept');
	});

	it('does nothing when confirmation is cancelled', async () => {
		await render();
		confirm.mockResolvedValue(false);
		MockSetting.instances[0]!.buttons[0]!.click();
		await Promise.resolve();
		expect(start).not.toHaveBeenCalled();
	});

	it('refuses a target changed while confirmation is open', async () => {
		const plugin = await render();
		confirm.mockImplementation(async () => {
			plugin.settings.cloudflareDeployment.d1DatabaseId = 'different-database';
			return true;
		});
		MockSetting.instances[0]!.buttons[0]!.click();
		await Promise.resolve();
		expect(start).not.toHaveBeenCalled();
	});

	it('hides server actions for a disconnected device with a completed deployment', async () => {
		await render(false, false, true);
		expect(MockSetting.instances).toHaveLength(0);
	});

	it('repairs interrupted setup with an update intent, never another reset', async () => {
		const plugin = await render(false);
		expect(MockSetting.instances.map(item => item.nameEl.textContent)).toEqual(['Repair server']);
		const setting = MockSetting.instances.find(item => item.nameEl.textContent === 'Repair server');
		setting!.buttons[0]!.click();
		expect(start).toHaveBeenCalledExactlyOnceWith(plugin, 'update');
		expect(confirm).not.toHaveBeenCalled();
	});
	it('offers a confirmed resume instead of a repair action while cleanup is pending', async () => {
		const plugin = await render(false, true);
		confirm.mockResolvedValue(true);
		expect(MockSetting.instances.some(item => item.nameEl.textContent === 'Repair server')).toBe(false);
		MockSetting.instances[0]!.buttons[0]!.click();
		await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith(plugin, 'reset'));
	});

	it('requires confirmation of exact resources for delete-only authorization', async () => {
		const plugin = await render();
		confirm.mockResolvedValue(true);
		const setting = MockSetting.instances.find(item => item.nameEl.textContent === 'Delete server')!;
		setting.buttons[0]!.click();
		await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith(plugin, 'delete'));
		expect(confirm.mock.calls[0]![1].details.join(' ')).toContain('Nothing is rebuilt');
		expect(confirm.mock.calls[0]![1].details.join(' ')).toContain(plugin.settings.cloudflareDeployment.d1DatabaseId);
	});

});
