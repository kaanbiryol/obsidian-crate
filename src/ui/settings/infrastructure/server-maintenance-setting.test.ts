import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../../test/fakes/obsidian-ui';

const confirm = vi.fn<(_app: unknown, options: { warning?: boolean; details: string[] }) => Promise<boolean>>();
const start = vi.fn();

async function render(configured = true, deployed = false, mobile = false) {
	vi.doMock('obsidian', () => ({ ...createObsidianUiModule(), Platform: { isMobile: mobile } }));
	vi.doMock('../../../plugin/cloudflare-operations', () => ({ startCloudflareDeployment: start }));
	vi.doMock('../../confirmation-modal', () => ({ openConfirmationModal: confirm }));
	const { renderServerRepairSetting } = await import('./server-repair-setting');
	const plugin = {
		app: {},
		settings: { cloudflareDeployment: {
			lastDeployedVersion: deployed ? '0.1.0' : null,
			deploymentId: '0123456789abcdef', accountId: 'a'.repeat(32), accountName: 'Personal',
			workerName: 'crate-0123456789abcdef', d1DatabaseName: 'crate-0123456789abcdef',
			d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef', r2BucketName: 'crate-0123456789abcdef',
		} },
		syncRuntime: { isConfigured: () => configured },
	};
	renderServerRepairSetting(new FakeElement('div') as never, plugin as never);
	return plugin;
}

beforeEach(() => { resetObsidianUiMocks(); confirm.mockReset(); start.mockReset(); });
afterEach(() => {
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../plugin/cloudflare-operations');
	vi.doUnmock('../confirmation-modal');
});

describe('server maintenance settings', () => {
	it('does not offer rebuild for a connected server', async () => {
		await render();
		expect(MockSetting.instances).toHaveLength(0);
	});

	it('hides server actions for a disconnected device with a completed deployment', async () => {
		await render(false, true);
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
	it('requires confirmation of exact resources for delete-only authorization', async () => {
		const plugin = await render();
		const { renderServerDeleteSetting } = await import('./server-delete-setting');
		renderServerDeleteSetting(new FakeElement('div') as never, plugin as never);
		confirm.mockResolvedValue(true);
		const setting = MockSetting.instances.find(item => item.nameEl.textContent === 'Delete server and all data')!;
		setting.buttons[0]!.click();
		await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith(plugin, 'delete'));
		expect(confirm.mock.calls[0]![1].details.join(' ')).toContain('Your local vault files are kept');
		expect(confirm.mock.calls[0]![1].details.join(' ')).toContain(plugin.settings.cloudflareDeployment.d1DatabaseId);
		// Like the encryption flows, an irreversible deletion requires typing a word.
		expect(confirm.mock.calls[0]![1]).toMatchObject({ warning: true, typedConfirmation: 'delete' });
	});

});


it.each(['cancel', 'changed target'])('does not delete after %s', async reason => {
	const plugin = await render();
	const { renderServerDeleteSetting } = await import('./server-delete-setting');
	renderServerDeleteSetting(new FakeElement('div') as never, plugin as never);
	confirm.mockImplementation(async () => {
		if (reason === 'changed target') plugin.settings.cloudflareDeployment.d1DatabaseId = 'other';
		return reason !== 'cancel';
	});
	MockSetting.instances[0]!.buttons[0]!.click();
	await Promise.resolve();
	expect(start).not.toHaveBeenCalled();
});

describe('on mobile', () => {
	it('points repair to the desktop', async () => {
		await render(false, false, true);
		const setting = MockSetting.instances.find(item => item.nameEl.textContent === 'Repair server')!;
		expect(setting.buttons).toHaveLength(0);
		expect(setting.descEl.collectText()).toContain('Available in Obsidian on a desktop.');
	});

	it('points deletion to the desktop', async () => {
		const plugin = await render(true, false, true);
		const { renderServerDeleteSetting } = await import('./server-delete-setting');
		renderServerDeleteSetting(new FakeElement('div') as never, plugin as never);
		const setting = MockSetting.instances.find(item => item.nameEl.textContent === 'Delete server and all data')!;
		expect(setting.buttons).toHaveLength(0);
		expect(setting.descEl.collectText()).toContain('Available in Obsidian on a desktop.');
	});

});
