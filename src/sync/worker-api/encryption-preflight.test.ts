import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerApiHttpClient, type ApiHttpTransport } from './http';
import { SyncApiClient } from './client';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../../encryption/key-bundle';
import { createEncryptionState } from '../../encryption/server-state';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function response(value: unknown) {
	const text = JSON.stringify(value);
	return { status: 200, text, arrayBuffer: new TextEncoder().encode(text).buffer, headers: {} };
}

it.each(['/sync/upload?path=private.md', '/sync/batch-upload', '/settings', '/reading/capture', '/reading/update', '/reminders/create', '/reminders/update', '/notifications/reminders-enrollment-token'])('never dispatches plaintext to %s after another device enables encryption', async path => {
	let enabled = false;
	const transport = vi.fn<ApiHttpTransport>(async request => {
		if (request.url.endsWith('/.well-known/crate')) return response({ service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: ['e2ee-v1'] });
		if (request.url.endsWith('/encryption')) return response({ encryption: enabled ? { mode: 'active' } : null });
		return response({ success: true });
	});
	const http = new WorkerApiHttpClient('https://crate.test', 'token', transport);
	const method = path.startsWith('/sync/upload') || path === '/settings' ? 'PUT' : 'POST';
	await http.requestJson(path, { method, body: 'Before conversion' });
	enabled = true;
	await expect(http.requestJson(path, { method, body: 'New private content' })).rejects.toMatchObject({ status: 428, code: 'encryption_required' });
	expect(transport.mock.calls.filter(([request]) => request.url.endsWith('/encryption'))).toHaveLength(2);
	expect(transport.mock.calls.every(([request]) => request.body !== 'New private content')).toBe(true);
});

it('does not send a private URL while an encrypted device is waiting for key recovery', async () => {
	const bundle = await createVaultKeyBundle();
	const encryption = createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode()));
	const transport = vi.fn<ApiHttpTransport>(async () => response({ encryption }));
	const api = new SyncApiClient('https://crate.test', 'token', transport);
	await expect(api.fetchPageTitle('https://private.example/secret')).resolves.toBeNull();
	expect(transport).toHaveBeenCalledOnce();
	expect(transport.mock.calls[0]?.[0].body).toBeUndefined();
	expect(transport.mock.calls[0]?.[0].url).toBe('https://crate.test/encryption');
});

it('skips the encryption probe while server responses confirm the vault is unencrypted', async () => {
	let enabled = false;
	const state = () => ({ 'X-Crate-Encryption-State': enabled ? 'on' : 'off' });
	const transport = vi.fn<ApiHttpTransport>(async request => {
		if (request.url.endsWith('/.well-known/crate')) return response({ service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: ['e2ee-v1'] });
		if (request.url.endsWith('/encryption')) return { ...response({ encryption: enabled ? { mode: 'active' } : null }), headers: state() };
		// The server rejects plaintext once encryption is enabled.
		if (enabled) return { ...response({ error: 'Unlock this vault', code: 'encryption_required' }), status: 428, headers: state() };
		return { ...response({ success: true }), headers: state() };
	});
	const http = new WorkerApiHttpClient('https://crate.test', 'token', transport);
	const probes = () => transport.mock.calls.filter(([request]) => request.url.endsWith('/encryption')).length;
	for (let write = 0; write < 3; write++) await http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Plain' });
	// Before: one probe per write.
	expect(probes()).toBe(1);
	enabled = true;
	await expect(http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Raced' })).rejects.toMatchObject({ status: 428 });
	await expect(http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'After' })).rejects.toMatchObject({ code: 'encryption_required' });
	expect(probes()).toBe(2);
	expect(transport.mock.calls.every(([request]) => request.body !== 'After')).toBe(true);
});

function unencryptedServer(refuse: () => number | null) {
	const off = { 'X-Crate-Encryption-State': 'off' };
	return vi.fn<ApiHttpTransport>(async request => {
		if (request.url.endsWith('/.well-known/crate')) return response({ service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: ['e2ee-v1'] });
		// A revoked or locked credential gets a refusal without the encryption state.
		const status = refuse();
		if (status) return { ...response({ error: 'Refused' }), status };
		if (request.url.endsWith('/encryption')) return { ...response({ encryption: null }), headers: off };
		return { ...response({ success: true }), headers: off };
	});
}

it.each([401, 403, 423, 428])('probes again after a %i instead of trusting an earlier unencrypted response', async status => {
	let refused: number | null = null;
	const transport = unencryptedServer(() => refused);
	const http = new WorkerApiHttpClient('https://crate.test', 'token', transport);
	await http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Plain' });
	// Another device turned encryption on and revoked this credential.
	refused = status;
	await expect(http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Raced' })).rejects.toMatchObject({ status });
	await expect(http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Later' })).rejects.toMatchObject({ status });
	// Before: the refusal carried no state, so "off" stayed cached and later edits sent plaintext.
	expect(transport.mock.calls.at(-1)?.[0].url).toBe('https://crate.test/encryption');
	expect(transport.mock.calls.every(([request]) => request.body !== 'Later')).toBe(true);
});

it('trusts an unencrypted response only briefly before sending plaintext', async () => {
	let now = 1_000;
	vi.spyOn(performance, 'now').mockImplementation(() => now);
	let enabled = false;
	const transport = vi.fn<ApiHttpTransport>(async request => {
		if (request.url.endsWith('/.well-known/crate')) return response({ service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: ['e2ee-v1'] });
		if (request.url.endsWith('/encryption')) return { ...response({ encryption: enabled ? { mode: 'active' } : null }), headers: { 'X-Crate-Encryption-State': enabled ? 'on' : 'off' } };
		return { ...response({ success: true }), headers: { 'X-Crate-Encryption-State': 'off' } };
	});
	const http = new WorkerApiHttpClient('https://crate.test', 'token', transport);
	const probes = () => transport.mock.calls.filter(([request]) => request.url.endsWith('/encryption')).length;
	await http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Plain' });
	now += 29_000;
	await http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Recent' });
	expect(probes()).toBe(1);
	enabled = true;
	now += 31_000;
	await expect(http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Idle' })).rejects.toMatchObject({ code: 'encryption_required' });
	// Before: the verdict never expired, so an edit after any idle period skipped the probe.
	expect(probes()).toBe(2);
	expect(transport.mock.calls.every(([request]) => request.body !== 'Idle')).toBe(true);
});

it('does not let a response already in flight restore a dropped unencrypted verdict', async () => {
	let refused: number | null = null;
	let releaseSlow!: () => void;
	const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
	const server = unencryptedServer(() => refused);
	const transport = vi.fn<ApiHttpTransport>(async request => {
		// The server handled this upload before revoking the credential; its response arrives last.
		if (request.body === 'Slow') { const handled = await server(request); await slow; return handled; }
		return server(request);
	});
	const http = new WorkerApiHttpClient('https://crate.test', 'token', transport);
	await http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Plain' });
	const slowUpload = http.requestJson('/sync/upload?path=slow.md', { method: 'PUT', body: 'Slow' });
	await vi.waitFor(() => expect(transport.mock.calls.some(([request]) => request.body === 'Slow')).toBe(true));
	refused = 401;
	await expect(http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Raced' })).rejects.toMatchObject({ status: 401 });
	releaseSlow();
	await slowUpload;
	await expect(http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Later' })).rejects.toMatchObject({ status: 401 });
	expect(transport.mock.calls.every(([request]) => request.body !== 'Later')).toBe(true);
});

it.each([['an unencrypted', ['e2ee-v1']], ['an encryption-incapable', []]])('refuses plaintext to %s server while this vault last synced encrypted', async (_kind, capabilities) => {
	const off = { 'X-Crate-Encryption-State': 'off' };
	const transport = vi.fn<ApiHttpTransport>(async request => {
		if (request.url.endsWith('/.well-known/crate')) return response({ service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities });
		if (request.url.endsWith('/encryption')) return { ...response({ encryption: null }), headers: off };
		return { ...response({ success: true }), headers: off };
	});
	const http = new WorkerApiHttpClient('https://crate.test', 'token', transport);
	http.refusePlaintext(true);
	await http.requestJson('/sync/changes?since=0');
	await expect(http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Private' })).rejects.toMatchObject({ status: 428, code: 'encryption_downgrade' });
	expect(transport.mock.calls.every(([request]) => request.body !== 'Private')).toBe(true);
	// Confirming the downgrade lets the same client sync without encryption.
	http.refusePlaintext(false);
	await http.requestJson('/sync/upload?path=note.md', { method: 'PUT', body: 'Private' });
	expect(transport.mock.calls.some(([request]) => request.body === 'Private')).toBe(true);
});
