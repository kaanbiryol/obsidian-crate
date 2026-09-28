import release from '../../cloudflare/server-release.json';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';

async function setup(revision?: number, development?: { number: number; worker: string }) {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../../cloudflare/embedded-artifacts', () => ({ EMBEDDED_CLOUDFLARE_ARTIFACT: { fingerprint: 'a'.repeat(64), development } }));
	const deployment = { workerName: 'crate-0123456789abcdef', workersSubdomain: 'example', lastKnownRevision: revision };
	const plugin = {
		settings: { cloudflareDeployment: deployment, workerUrl: 'https://crate-0123456789abcdef.example.workers.dev' },
		syncRuntime: { getVersionInfo: vi.fn(async () => ({ serverRevision: 42, deploymentFingerprint: 'b'.repeat(64) })) },
		writeSettings: vi.fn(async (update: { cloudflareDeployment: typeof deployment }) => { plugin.settings.cloudflareDeployment = update.cloudflareDeployment; }),
	};
	const { renderUpdateVersions } = await import('./version-settings');
	const row = new MockSetting(new FakeElement('div'));
	const render = () => renderUpdateVersions(row as never, plugin as never, vi.fn());
	render();
	return { plugin, row, render };
}

afterEach(() => {
	resetObsidianUiMocks();
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../cloudflare/server-release.json');
	vi.doUnmock('../../cloudflare/embedded-artifacts');
});

it('shows the saved revision without requesting remote metadata', async () => {
	const { plugin, row } = await setup(37);
	expect(row.descEl.textContent).toContain('Current version: 37');
	expect(plugin.syncRuntime.getVersionInfo).not.toHaveBeenCalled();
});

it('persists a manual check for subsequent renders', async () => {
	const { plugin, row, render } = await setup();
	row.buttons[0]!.click();
	await vi.waitFor(() => expect(plugin.writeSettings).toHaveBeenCalledOnce());
	expect(plugin.settings.cloudflareDeployment.lastKnownRevision).toBe(42);
	render();
	expect(row.descEl.textContent).toContain('Current version: 42');
	expect(plugin.syncRuntime.getVersionInfo).toHaveBeenCalledOnce();
});

it('keeps the last known revision when a manual check fails', async () => {
	const { plugin, row } = await setup(37);
	plugin.syncRuntime.getVersionInfo.mockRejectedValue(new Error('Offline'));
	row.buttons[0]!.click();
	await vi.waitFor(() => expect(row.descEl.textContent).toContain('Could not check the server'));
	expect(row.descEl.textContent).toContain('Current version: 37');
	expect(plugin.writeSettings).not.toHaveBeenCalled();
});

it('does not reuse or overwrite another server’s saved revision', async () => {
	const { plugin, row, render } = await setup(37);
	plugin.settings.workerUrl = 'https://another.example.com';
	render();
	expect(row.descEl.textContent).toContain('Current version: Unknown');
	row.buttons[0]!.click();
	await vi.waitFor(() => expect(row.descEl.textContent).toContain('Current version: 42'));
	expect(plugin.writeSettings).not.toHaveBeenCalled();
});

it('requires a live comparison before declaring a same-revision mismatch', async () => {
	const { plugin, row } = await setup(release.revision);
	const available = vi.fn();
	const { renderUpdateVersions } = await import('./version-settings');
	renderUpdateVersions(row as never, plugin as never, vi.fn(), available);
	expect(row.nameEl.textContent).toBe('Check server version');
	expect(row.descEl.textContent).toContain('Select Check live server');
	expect(available).toHaveBeenLastCalledWith(false);
	expect(plugin.syncRuntime.getVersionInfo).not.toHaveBeenCalled();
});

it('keeps a confirmed stable same-revision mismatch blocked with upgrade guidance', async () => {
	const { plugin, row } = await setup(release.revision);
	const available = vi.fn();
	const { renderUpdateVersions } = await import('./version-settings');
	renderUpdateVersions(row as never, plugin as never, vi.fn(), available);
	plugin.syncRuntime.getVersionInfo.mockResolvedValue({ serverRevision: release.revision, deploymentFingerprint: 'b'.repeat(64) });
	row.buttons.at(-1)!.click();
	await vi.waitFor(() => expect(row.nameEl.textContent).toBe('Server build differs'));
	expect(row.descEl.textContent).toContain('Update the plugin to get a newer server release');
	expect(available).toHaveBeenLastCalledWith(false);
});

it('offers an update when the saved server revision is older', async () => {
	vi.doMock('../../cloudflare/server-release.json', () => ({ default: { revision: 2 } }));
	const { plugin, row } = await setup(1);
	const available = vi.fn();
	const { renderUpdateVersions } = await import('./version-settings');
	renderUpdateVersions(row as never, plugin as never, vi.fn(), available);
	expect(row.nameEl.textContent).toBe('Cloudflare update available');
	expect(available).toHaveBeenLastCalledWith(true);
});


it.each([true, false])('enables a same-revision development update or stable promotion after a live check (development=%s)', async developmentTarget => {
  const development = { number: 2, worker: 'crate-0123456789abcdef' };
  const { plugin, row } = await setup(release.revision, developmentTarget ? development : undefined);
  const available = vi.fn();
  const { renderUpdateVersions } = await import('./version-settings');
  renderUpdateVersions(row as never, plugin as never, vi.fn(), available);
  plugin.syncRuntime.getVersionInfo.mockResolvedValue({ serverRevision: release.revision, deploymentFingerprint: 'b'.repeat(64), developmentBuild: { ...development, number: 1 } } as Awaited<ReturnType<typeof plugin.syncRuntime.getVersionInfo>>);
  row.buttons.at(-1)!.click();
  await vi.waitFor(() => expect(available).toHaveBeenLastCalledWith(true));
  expect(row.descEl.textContent).toContain(`${release.revision}-dev.1`);
});
