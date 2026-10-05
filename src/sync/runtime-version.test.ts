import { afterEach, expect, it, vi } from 'vitest';
import { CRATE_PLUGIN_PROTOCOL, type CrateServerInfo } from '../protocol';
import { createDeferred, createRuntimeHarness, initializeRuntime, mockApiClient } from './runtime-test-harness';

const info: CrateServerInfo = {
	service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [],
	serverRevision: 6, deploymentFingerprint: 'a'.repeat(64),
	developmentBuild: { number: 2, worker: 'crate-0123456789abcdef' },
};
const client = () => ({ getServerInfo: vi.fn(async () => info), testConnection: vi.fn(), putSharedSettings: vi.fn() });
afterEach(() => { vi.restoreAllMocks(); });

it('reuses recent version details for display, expires them, and deduplicates pending checks', async () => {
	const { runtime } = createRuntimeHarness();
	const api = client(), pending = createDeferred<CrateServerInfo>();
	const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
	api.getServerInfo.mockReturnValueOnce(pending.promise);
	await initializeRuntime(runtime);
	mockApiClient(runtime, api);
	const first = runtime.getVersionInfo(), second = runtime.getVersionInfo();
	expect(api.getServerInfo).toHaveBeenCalledOnce();
	expect(runtime.getCachedVersionInfo()).toBeUndefined();
	pending.resolve(info);
	await Promise.all([first, second]);
	expect(runtime.getCachedVersionInfo()).toEqual(info);
	expect(api.getServerInfo).toHaveBeenCalledOnce();
	now.mockReturnValue(31_000);
	expect(runtime.getCachedVersionInfo()).toBeUndefined();
});

it.each(['address', 'account', 'database', 'client'] as const)('does not reuse version information after changing the %s', async change => {
	const { runtime, settings } = createRuntimeHarness();
	await initializeRuntime(runtime);
	mockApiClient(runtime, client());
	await runtime.getVersionInfo();
	if (change === 'address') settings.workerUrl = 'https://another.example.com';
	else if (change === 'client') { await initializeRuntime(runtime); mockApiClient(runtime, client()); }
	else settings.cloudflareDeployment = { accountId: change === 'account' ? 'other' : undefined, d1DatabaseId: change === 'database' ? 'other' : undefined } as never;
	expect(runtime.getCachedVersionInfo()).toBeUndefined();
});

it('drops a delayed version result when the connection changes', async () => {
	const { runtime, settings } = createRuntimeHarness();
	const api = client(), pending = createDeferred<CrateServerInfo>();
	api.getServerInfo.mockReturnValueOnce(pending.promise);
	await initializeRuntime(runtime);
	mockApiClient(runtime, api);
	const check = runtime.getVersionInfo();
	settings.workerUrl = 'https://another.example.com';
	pending.resolve(info);
	await expect(check).rejects.toThrow('Server changed');
	expect(runtime.getCachedVersionInfo()).toBeUndefined();
});

it('clears previous results after a failed refresh', async () => {
	const { runtime } = createRuntimeHarness();
	const api = client();
	await initializeRuntime(runtime);
	mockApiClient(runtime, api);
	await runtime.getVersionInfo();
	api.getServerInfo.mockRejectedValueOnce(new Error('Offline'));
	await expect(runtime.getVersionInfo()).rejects.toThrow('Offline');
	expect(runtime.getCachedVersionInfo()).toBeUndefined();
});
