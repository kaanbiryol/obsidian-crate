import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { exchangeSelfHostedPairingCode } from './self-hosted-pairing';
import { CRATE_PLUGIN_PROTOCOL } from '../protocol';

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));
beforeEach(() => { vi.stubGlobal('window', globalThis); vi.mocked(requestUrl).mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });
function response(body: unknown, status = 200) {
	return { status, headers: {}, text: JSON.stringify(body), json: body, arrayBuffer: new ArrayBuffer(0) };
}
function mockResponse(body: unknown, status = 200) {
	vi.mocked(requestUrl).mockImplementation(request => {
		const url = typeof request === 'string' ? request : request.url;
		const result = url.endsWith('/.well-known/crate')
			? response({ service: 'crate', serverVersion: 'crate', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [] })
			: response(body, status);
		return Object.assign(Promise.resolve(result), {
			arrayBuffer: Promise.resolve(result.arrayBuffer), json: Promise.resolve(result.json), text: Promise.resolve(result.text),
		});
	});
}
it('exchanges a pairing code for a validated credential without an existing vault credential', async () => {
	const token = 'b'.repeat(64), code = `crate-pair-${'a'.repeat(64)}`;
	mockResponse({ authToken: token });
	await expect(exchangeSelfHostedPairingCode('https://crate.example', code, new AbortController().signal)).resolves.toBe(token);
	expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({
		url: 'https://crate.example/__crate/pair', method: 'POST', body: JSON.stringify({ code }),
	}));
});
it('preserves a rejected pairing error and rejects malformed credential responses', async () => {
	mockResponse({ error: 'Pairing code expired or already used. Generate a new code on your server.' }, 401);
	await expect(exchangeSelfHostedPairingCode('https://crate.example', 'code', new AbortController().signal)).rejects.toThrow('Pairing code expired');
	mockResponse({ authToken: 'invalid' });
	await expect(exchangeSelfHostedPairingCode('https://crate.example', 'code', new AbortController().signal)).rejects.toThrow('valid device token');
});
it('does not send a pairing request after the plugin is unloaded', async () => {
	const controller = new AbortController(); controller.abort();
	await expect(exchangeSelfHostedPairingCode('https://crate.example', 'code', controller.signal)).rejects.toThrow();
	expect(requestUrl).not.toHaveBeenCalled();
});
