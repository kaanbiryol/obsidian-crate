import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../../test/fakes/obsidian-ui';

const connectSelfHostedServer = vi.fn(async () => ({ encrypted: false }));
const startVaultReplacement = vi.fn(() => true);
const offerFeatureChoice = vi.fn(async () => {});

afterEach(() => {
	resetObsidianUiMocks();
	vi.clearAllMocks();
	vi.resetModules();
	for (const path of ['obsidian', '../../../plugin/self-hosted-connection', '../../../plugin/feature-settings', '../../../plugin/sync-integration']) vi.doUnmock(path);
});

async function connect(reconnect: boolean) {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../../../plugin/self-hosted-connection', () => ({ connectSelfHostedServer, updateSelfHostedServerAddress: vi.fn() }));
	vi.doMock('../../../plugin/feature-settings', () => ({ offerFeatureChoice }));
	vi.doMock('../../../plugin/sync-integration', () => ({ startVaultReplacement }));
	const { renderSelfHostedSetting } = await import('./self-hosted-setting');
	const plugin = { settings: { workerUrl: reconnect ? 'https://crate.example' : '', cloudflareDeployment: null }, syncRuntime: { isConfigured: () => reconnect } };
	const rerender = vi.fn();
	renderSelfHostedSetting({ containerEl: new FakeElement('div'), plugin, rerender } as never, reconnect);
	MockSetting.instances[0]?.texts[0]?.change('https://crate.example');
	MockSetting.instances[1]?.texts[0]?.change('crate-pair-synthetic');
	MockSetting.instances[2]?.buttons[0]?.click();
	await vi.waitFor(() => expect(rerender).toHaveBeenCalledOnce());
	return plugin;
}

it('offers the feature step after connecting to a self-hosted or local server', async () => {
	const plugin = await connect(false);
	expect(connectSelfHostedServer).toHaveBeenCalledWith(plugin, 'https://crate.example', 'crate-pair-synthetic', false);
	expect(offerFeatureChoice).toHaveBeenCalledExactlyOnceWith(plugin);
});

it('does not offer the feature step again when reconnecting', async () => {
	await connect(true);
	expect(connectSelfHostedServer).toHaveBeenCalledOnce();
	expect(offerFeatureChoice).not.toHaveBeenCalled();
	expect(startVaultReplacement).not.toHaveBeenCalled();
});

it('starts a confirmed replacement after the feature step', async () => {
	const plugin = await connect(false);
	await vi.waitFor(() => expect(startVaultReplacement).toHaveBeenCalledExactlyOnceWith(plugin));
	expect(offerFeatureChoice.mock.invocationCallOrder[0]).toBeLessThan(startVaultReplacement.mock.invocationCallOrder[0]!);
});

it('does not start syncing an encrypted server before its keys arrive', async () => {
	connectSelfHostedServer.mockResolvedValueOnce({ encrypted: true });
	await connect(false);
	await vi.waitFor(() => expect(offerFeatureChoice).toHaveBeenCalledOnce());
	expect(startVaultReplacement).not.toHaveBeenCalled();
});
