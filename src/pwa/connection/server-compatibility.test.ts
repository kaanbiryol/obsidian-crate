import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol/server-info';
import { forgetCompatibleProtocol, requireCompatibleProtocol, requireCompatibleServer } from './server-compatibility';
import { makeApiFetch } from './api-fetch';

vi.mock('../reminders/encryption-session', () => ({ prepareReminderEncryption: async () => null, reminderEncryptionSnapshot: () => ({ status: 'unencrypted' }) }));

const info = { service: 'crate', serverVersion: '0.1.0', serverRevision: 4, protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [], reminderOperationDay: 20_000 };
const fetchMock = vi.fn(async () => Response.json(info));

// Each test starts a minute later, so a result shared by the previous test has expired.
let now = performance.now();
beforeEach(() => {
	vi.spyOn(performance, 'now').mockImplementation(() => now);
	now += 60_000;
	forgetCompatibleProtocol();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fetchMock.mockClear(); });

it('reads server info once for a save operation id and its protocol header', async () => {
	expect((await requireCompatibleServer()).reminderOperationDay).toBe(20_000);
	expect(await requireCompatibleProtocol()).toBe(CRATE_PLUGIN_PROTOCOL.current);
	// Before: each read sent its own request, adding a serial round trip per save.
	expect(fetchMock).toHaveBeenCalledOnce();
	// A later save checks the server again.
	now += 5_000;
	await requireCompatibleServer();
	expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('retries at once after a failed read', async () => {
	fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
	await expect(requireCompatibleServer()).rejects.toThrow('Update the Crate server');
	await requireCompatibleServer();
	expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('negotiates the change protocol once per page until the server refuses it', async () => {
	vi.stubGlobal('localStorage', { getItem: () => 'session' });
	vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
	vi.stubGlobal('navigator', { userAgent: 'Test Browser', maxTouchPoints: 0 });
	let refuse = false;
	const network = vi.fn(async (path: string) => path === '/.well-known/crate' ? Response.json(info)
		: refuse ? Response.json({ error: 'Update Crate and reload the web app before making changes.', code: 'protocol_incompatible' }, { status: 428 })
			: Response.json({ success: true }));
	vi.stubGlobal('fetch', network);
	const api = makeApiFetch('session', vi.fn());
	const change = () => api('/reminders/delete', { method: 'DELETE', body: '{}' });
	const serverInfoReads = () => network.mock.calls.filter(([path]) => path === '/.well-known/crate').length;
	await change();
	now += 6_000;
	await change();
	// Before: a change more than 5 s after the previous one read server info first.
	expect(serverInfoReads()).toBe(1);
	refuse = true;
	expect((await change()).status).toBe(428);
	refuse = false;
	await change();
	// The refusal makes the next change negotiate again.
	expect(serverInfoReads()).toBe(2);
});
