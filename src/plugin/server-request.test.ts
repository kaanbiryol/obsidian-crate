import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import type CratePlugin from './CratePlugin';
import { endPluginLifecycle } from './lifecycle-state';
import { serverRequest } from './server-request';
import { readingServerRequest } from '../reading/server';
import { CRATE_PLUGIN_PROTOCOL } from '../protocol';

const transport = vi.hoisted(() => vi.fn<(request: string | RequestUrlParam) => Promise<RequestUrlResponse>>());
vi.mock('obsidian', () => ({ requestUrl: transport }));
beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}
function response(value: unknown) {
	const text = JSON.stringify(value);
	return { status: 200, headers: {}, text, json: value, arrayBuffer: new TextEncoder().encode(text).buffer };
}
function harness(capabilities = ['reading-v1', 'shared-features-v1']) {
	let token = 'old-token';
	const plugin = {
		settings: { workerUrl: 'https://old.example' },
		secretStorage: { get: () => token },
	} as unknown as CratePlugin;
	const info = response({ service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities });
	transport.mockImplementation(async request => {
		const url = typeof request === 'string' ? request : request.url;
		return url.endsWith('/.well-known/crate') ? info : response({ success: true });
	});
	return { plugin, info, change: (kind: string) => {
		if (kind === 'unload') endPluginLifecycle(plugin);
		else if (kind === 'server') plugin.settings.workerUrl = 'https://new.example';
		else token = 'new-token';
	} };
}

for (const stage of ['metadata', 'mutation']) {
	it.each(['unload', 'server', 'credential'])(`rejects ${stage} completion after %s without dispatching further work`, async kind => {
		const { plugin, info, change } = harness();
		const started = deferred();
		const release = deferred();
		transport.mockImplementation(async request => {
			const url = typeof request === 'string' ? request : request.url;
			const metadata = url.endsWith('/.well-known/crate');
			if (metadata === (stage === 'metadata')) { started.resolve(); await release.promise; }
			return metadata ? info : response({ success: true });
		});
		const pending = serverRequest(plugin, '/features', { enabled: false });
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await started.promise;
		change(kind);
		release.resolve();
		await rejected;
		expect(transport).toHaveBeenCalledTimes(stage === 'metadata' ? 1 : 2);
	});
}

it('checks capabilities and mutation compatibility with one validated metadata request', async () => {
	const { plugin } = harness(['shared-features-v1']);
	await expect(serverRequest(plugin, '/features', { enabled: false }, {
		capabilities: { 'shared-features-v1': 'Update shared features.' },
	})).resolves.toEqual({ success: true });
	expect(transport).toHaveBeenCalledTimes(2);
	expect(transport).toHaveBeenLastCalledWith(expect.objectContaining({
		url: 'https://old.example/features', method: 'POST',
	}));
	const lastRequest = transport.mock.calls.at(-1)?.[0];
	expect(typeof lastRequest === 'object' && lastRequest.headers?.Authorization).toBe('Bearer old-token');
});

it('rejects invalid metadata before dispatching the feature request', async () => {
	const { plugin } = harness();
	transport.mockResolvedValueOnce(response({ capabilities: ['reading-v1'] }));
	await expect(readingServerRequest(plugin, '/reading/policy', {})).rejects.toThrow('invalid Crate compatibility metadata');
	expect(transport).toHaveBeenCalledOnce();
});

it.each([
	['/reading/policy', [], 'web Reading'],
	['/reading/fetching', ['reading-v1'], 'article fetching'],
	['/reading/capture', ['reading-v1'], 'pending Reading saves'],
] as const)('keeps Reading capability requirements on %s', async (path, capabilities, message) => {
	const { plugin } = harness([...capabilities]);
	await expect(readingServerRequest(plugin, path, {})).rejects.toThrow(message);
	expect(transport).toHaveBeenCalledOnce();
});

it('does not dispatch when the plugin is already unloaded', async () => {
	const { plugin, change } = harness();
	change('unload');
	await expect(serverRequest(plugin, '/features')).rejects.toMatchObject({ name: 'AbortError' });
	expect(transport).not.toHaveBeenCalled();
});
