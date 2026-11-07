import { expect, it, vi } from 'vitest';
import release from '../../cloudflare/server-release.json';
import { checkServerVersion, isBundledServerNewer } from './server-version';

vi.mock('../../cloudflare/deployment/embedded-artifacts', () => ({ EMBEDDED_CLOUDFLARE_ARTIFACT: { fingerprint: 'a'.repeat(64) } }));

it('offers the bundled server for an older revision or a development build it can replace', () => {
	const development = { worker: 'crate-0123456789abcdef', number: 3 };
	expect(isBundledServerNewer({})).toBe(false);
	expect(isBundledServerNewer({ serverRevision: release.revision - 1 })).toBe(true);
	expect(isBundledServerNewer({ serverRevision: release.revision })).toBe(false);
	expect(isBundledServerNewer({ serverRevision: release.revision, deploymentFingerprint: 'a'.repeat(64), developmentBuild: development })).toBe(false);
	expect(isBundledServerNewer({ serverRevision: release.revision, deploymentFingerprint: 'b'.repeat(64) })).toBe(false);
	expect(isBundledServerNewer({ serverRevision: release.revision, deploymentFingerprint: 'b'.repeat(64), developmentBuild: development })).toBe(true);
	expect(isBundledServerNewer({ serverRevision: release.revision + 1, deploymentFingerprint: 'b'.repeat(64) })).toBe(false);
});

function managedPlugin() {
	const workerName = 'crate-0123456789abcdef';
	let respond!: (info: { serverRevision: number }) => void;
	const plugin = {
		settings: { workerUrl: `https://${workerName}.example.workers.dev`, cloudflareDeployment: { workerName, workersSubdomain: 'example', accountId: 'account', lastKnownRevision: 1 } },
		syncRuntime: { getVersionInfo: () => new Promise(resolve => { respond = resolve; }) },
		writeSettings: vi.fn(async () => {}),
	};
	return { plugin, respond: (serverRevision: number) => respond({ serverRevision }) };
}

it('records the managed server revision it read', async () => {
	const { plugin, respond } = managedPlugin();
	const checked = checkServerVersion(plugin as never);
	respond(7);
	await expect(checked).resolves.toEqual({ serverRevision: 7 });
	expect(plugin.writeSettings).toHaveBeenCalledExactlyOnceWith({ cloudflareDeployment: { ...plugin.settings.cloudflareDeployment, lastKnownRevision: 7 } });
});

it.each(['address', 'account'] as const)('rejects a version read after the server %s changes', async change => {
	const { plugin, respond } = managedPlugin();
	const checked = checkServerVersion(plugin as never);
	if (change === 'address') plugin.settings.workerUrl = 'https://other.example';
	else plugin.settings.cloudflareDeployment = { ...plugin.settings.cloudflareDeployment, accountId: 'other' };
	respond(7);
	await expect(checked).rejects.toThrow('Server connection changed');
	expect(plugin.writeSettings).not.toHaveBeenCalled();
});
