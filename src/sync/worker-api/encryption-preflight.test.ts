import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerApiHttpClient, type ApiHttpTransport } from './http';
import { SyncApiClient } from '../api';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../../encryption/key-bundle';
import { createEncryptionState } from '../../encryption/server-state';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());
function response(value: unknown) {
	const text = JSON.stringify(value);
	return { status: 200, text, arrayBuffer: new TextEncoder().encode(text).buffer, headers: {} };
}

it.each(['/sync/upload?path=private.md', '/sync/batch-upload', '/settings', '/reading/capture', '/reading/update', '/reading/prepare', '/reminders/create', '/reminders/update'])('never dispatches plaintext to %s after another device enables encryption', async path => {
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
	const bundle = createVaultKeyBundle();
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
