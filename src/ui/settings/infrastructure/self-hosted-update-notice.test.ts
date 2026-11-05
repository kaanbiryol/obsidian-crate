import release from '../../../cloudflare/server-release.json';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../../test/fakes/obsidian-ui';

const bundled = 'a'.repeat(64);

type Live = { serverRevision?: number; deploymentFingerprint?: string; developmentBuild?: { worker: string; number: number } };

async function render(live: Live | Error, options: { deployment?: object } = {}) {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../../../cloudflare/deployment/embedded-artifacts', () => ({ EMBEDDED_CLOUDFLARE_ARTIFACT: { fingerprint: bundled } }));
	const { renderSelfHostedUpdateNotice } = await import('./self-hosted-update-notice');
	const plugin = {
		settings: { workerUrl: 'https://crate.example', cloudflareDeployment: options.deployment ?? null },
		syncRuntime: { isConfigured: () => true, getVersionInfo: vi.fn(async () => { if (live instanceof Error) throw live; return live; }) },
	};
	const show = () => renderSelfHostedUpdateNotice({ containerEl: new FakeElement('div'), plugin, rerender: vi.fn() } as never);
	show();
	await new Promise(resolve => setTimeout(resolve, 0));
	return { plugin, show };
}

afterEach(() => {
	resetObsidianUiMocks();
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../../cloudflare/deployment/embedded-artifacts');
});

it('tells a self-hosted user to update an older server on its host', async () => {
	await render({ serverRevision: release.revision - 1 });
	expect(MockSetting.instances).toHaveLength(1);
	expect(MockSetting.instances[0]!.nameEl.textContent).toBe('Server update available');
	expect(MockSetting.instances[0]!.descEl.textContent).toContain(`Current version: ${release.revision - 1} · Bundled version: ${release.revision}`);
	expect(MockSetting.instances[0]!.descEl.textContent).toContain('computer running your server');
});

it('flags a development server build that this stable plugin can replace', async () => {
	await render({ serverRevision: release.revision, deploymentFingerprint: 'b'.repeat(64), developmentBuild: { worker: 'crate', number: 3 } });
	expect(MockSetting.instances).toHaveLength(1);
});

it('stays quiet for a matching, unverifiable, newer, or unreachable server', async () => {
	// A different stable build at the same revision is not an update, as for Cloudflare servers.
	for (const live of [{ serverRevision: release.revision, deploymentFingerprint: bundled }, { serverRevision: release.revision, deploymentFingerprint: 'b'.repeat(64) },
		{ serverRevision: release.revision }, { serverRevision: release.revision + 1 }, new Error('offline')]) {
		await render(live);
		expect(MockSetting.instances).toHaveLength(0);
		vi.resetModules();
	}
});

it('checks the server once across settings rerenders and never for Cloudflare deployments', async () => {
	const { plugin, show } = await render({ serverRevision: release.revision, deploymentFingerprint: bundled });
	show(); show();
	expect(plugin.syncRuntime.getVersionInfo).toHaveBeenCalledOnce();
	const cloudflare = await render({ serverRevision: 1 }, { deployment: { workerName: 'crate' } });
	expect(cloudflare.plugin.syncRuntime.getVersionInfo).not.toHaveBeenCalled();
});
