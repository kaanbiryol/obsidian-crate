import release from '../../cloudflare/server-release.json';
import type { DevelopmentBuild } from '../../cloudflare/server-build';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';

type Version = { serverRevision?: number; deploymentFingerprint?: string; developmentBuild?: DevelopmentBuild };
const liveVersion: Version = { serverRevision: 42, deploymentFingerprint: 'b'.repeat(64) };
const worker = 'crate-0123456789abcdef';

async function setup(options: { revision?: number; development?: DevelopmentBuild; live?: Version | Promise<Version>; cached?: Version } = {}) {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../../cloudflare/embedded-artifacts', () => ({ EMBEDDED_CLOUDFLARE_ARTIFACT: { fingerprint: 'a'.repeat(64), development: options.development } }));
	const deployment = { workerName: worker, workersSubdomain: 'example', lastKnownRevision: options.revision };
	const plugin = {
		settings: { cloudflareDeployment: deployment, workerUrl: `https://${worker}.example.workers.dev` },
		syncRuntime: {
			getCachedVersionInfo: vi.fn(() => options.cached),
			getVersionInfo: vi.fn(async () => options.live ?? liveVersion),
		},
		writeSettings: vi.fn(async (update: { cloudflareDeployment: typeof deployment }) => { plugin.settings.cloudflareDeployment = update.cloudflareDeployment; }),
	};
	const { renderUpdateVersions } = await import('./version-settings');
	const row = new MockSetting(new FakeElement('div'));
	const available = vi.fn(), matching = vi.fn();
	const render = () => renderUpdateVersions(row as never, plugin as never, matching, available);
	render();
	return { plugin, row, render, available, matching };
}

afterEach(() => {
	resetObsidianUiMocks();
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../cloudflare/embedded-artifacts');
});

it('shows a known newer revision without requesting remote metadata', async () => {
	const { plugin, row } = await setup({ revision: 37 });
	expect(row.descEl.textContent).toContain('Current version: 37');
	expect(plugin.syncRuntime.getVersionInfo).not.toHaveBeenCalled();
});

it('explains that a newer development server needs a newer plugin bundle and blocks downgrade', async () => {
	const { plugin, row, available } = await setup({
		revision: release.revision + 1,
		development: { number: 13, worker },
		cached: { serverRevision: release.revision + 1, developmentBuild: { number: 14, worker }, deploymentFingerprint: 'b'.repeat(64) },
	});
	expect(row.nameEl.textContent).toBe('Plugin update required');
	expect(row.descEl.textContent).toContain(`Current version: ${release.revision + 1}-dev.14 · Bundled version: ${release.revision}-dev.13`);
	expect(row.descEl.textContent).toContain(`Use a plugin build with server revision ${release.revision + 1} or later`);
	expect(available).toHaveBeenLastCalledWith(false);
	expect(row.buttons[0]!.buttonEl.style.display).not.toBe('none');
	expect(plugin.syncRuntime.getVersionInfo).not.toHaveBeenCalled();
});

it('automatically checks a missing revision and persists it for subsequent renders', async () => {
	const { plugin, row, render } = await setup();
	await vi.waitFor(() => expect(plugin.writeSettings).toHaveBeenCalledOnce());
	expect(plugin.settings.cloudflareDeployment.lastKnownRevision).toBe(42);
	render();
	expect(row.descEl.textContent).toContain('Current version: 42');
	expect(plugin.syncRuntime.getVersionInfo).toHaveBeenCalledOnce();
});

it('keeps the last known revision when a manual check fails', async () => {
	const { plugin, row } = await setup({ revision: 37 });
	plugin.syncRuntime.getVersionInfo.mockRejectedValue(new Error('Offline'));
	row.buttons[0]!.click();
	await vi.waitFor(() => expect(row.descEl.textContent).toContain('Could not check the server'));
	expect(row.descEl.textContent).toContain('Current version: 37');
	expect(plugin.writeSettings).not.toHaveBeenCalled();
});

it('does not overwrite managed server metadata after switching to another address', async () => {
	const { plugin, row, render } = await setup({ revision: 37 });
	plugin.settings.workerUrl = 'https://another.example.com';
	render();
	expect(row.descEl.textContent).toBe('Checking live server…');
	await vi.waitFor(() => expect(row.descEl.textContent).toContain('Current version: 42'));
	expect(plugin.writeSettings).not.toHaveBeenCalled();
});

it('keeps a confirmed stable same-revision mismatch blocked with upgrade guidance', async () => {
	const { row, available, plugin } = await setup({ revision: release.revision, live: { ...liveVersion, serverRevision: release.revision } });
	await vi.waitFor(() => expect(row.nameEl.textContent).toBe('Server build differs'));
	expect(row.descEl.textContent).toContain('Update the plugin to get a newer server release');
	expect(available).toHaveBeenLastCalledWith(false);
	expect(plugin.syncRuntime.getVersionInfo).toHaveBeenCalledOnce();
});

it('offers an update immediately when the saved server revision is older', async () => {
	const { row, available, plugin } = await setup({ revision: release.revision - 1 });
	expect(row.nameEl.textContent).toBe('Cloudflare update available');
	expect(available).toHaveBeenLastCalledWith(true);
	expect(plugin.syncRuntime.getVersionInfo).not.toHaveBeenCalled();
});

it.each([true, false])('automatically confirms a development update or stable promotion (development=%s)', async developmentTarget => {
	const { plugin, row, available } = await setup({ revision: release.revision,
		development: developmentTarget ? { number: 2, worker } : undefined,
		live: { ...liveVersion, serverRevision: release.revision, developmentBuild: { number: 1, worker } },
	});
	await vi.waitFor(() => expect(available).toHaveBeenLastCalledWith(true));
	expect(row.descEl.textContent).toContain(`${release.revision}-dev.1`);
	expect(plugin.syncRuntime.getVersionInfo).toHaveBeenCalledOnce();
});

it('reuses a recent confirmed development build when reopening settings', async () => {
	const { plugin, row, render, available } = await setup({ revision: release.revision,
		development: { number: 2, worker },
		cached: { ...liveVersion, serverRevision: release.revision, developmentBuild: { number: 1, worker } },
	});
	expect(available).toHaveBeenLastCalledWith(true);
	render();
	expect(row.descEl.textContent).toContain(`${release.revision}-dev.1`);
	expect(plugin.syncRuntime.getVersionInfo).not.toHaveBeenCalled();
});

it('routes a cached matching artifact to verification without checking again', async () => {
	const { matching, plugin } = await setup({ revision: release.revision, cached: { serverRevision: release.revision, deploymentFingerprint: 'a'.repeat(64) } });
	expect(matching).toHaveBeenCalledOnce();
	expect(plugin.syncRuntime.getVersionInfo).not.toHaveBeenCalled();
});

it('rejects a delayed automatic check after switching the connected server', async () => {
	let finish!: (info: Version) => void;
	const live = new Promise<Version>(resolve => { finish = resolve; });
	const { plugin, row, available } = await setup({ revision: release.revision, live });
	expect(row.buttons[0]!.buttonEl.textContent).toBe('Checking…');
	expect(available).toHaveBeenLastCalledWith(false);
	plugin.settings.workerUrl = 'https://another.example.com';
	finish({ serverRevision: 1, deploymentFingerprint: 'b'.repeat(64) });
	await vi.waitFor(() => expect(row.descEl.textContent).toContain('Could not check the server'));
	expect(plugin.writeSettings).not.toHaveBeenCalled();
	expect(available).toHaveBeenLastCalledWith(false);
});
