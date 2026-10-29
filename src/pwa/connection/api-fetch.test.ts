import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeApiFetch } from './api-fetch';
import { prepareReminderEncryption } from '../reminders/encryption-session';
import { invalidatePwaSession } from './session-generation';
import type { ApiFetch } from '../types';
import { adoptReminderFolder } from '../config';

vi.mock('../reminders/encryption-session', () => ({
	prepareReminderEncryption: vi.fn(async (_token: string, rawFetch: ApiFetch) => { await rawFetch('/encryption'); return null; }),
	reminderEncryptionSnapshot: () => ({ status: 'unencrypted' }),
}));
vi.mock('../config', async () => ({ ...await vi.importActual('../config'), adoptReminderFolder: vi.fn() }));
vi.mock('./server-compatibility', async () => {
	const { CRATE_PLUGIN_PROTOCOL } = await vi.importActual<typeof import('@/protocol/server-info')>('@/protocol/server-info');
	return { requireCompatibleProtocol: async () => CRATE_PLUGIN_PROTOCOL.current };
});

beforeEach(() => {
	vi.stubGlobal('localStorage', { getItem: () => 'session' });
	vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
	vi.stubGlobal('navigator', { userAgent: 'Test Browser', maxTouchPoints: 0 });
});
afterEach(() => { invalidatePwaSession(); vi.unstubAllGlobals(); vi.mocked(prepareReminderEncryption).mockClear(); vi.mocked(adoptReminderFolder).mockClear(); });

it('probes encryption once while server responses confirm the vault is unencrypted', async () => {
	let enabled = false;
	const headers = () => ({ 'X-Crate-Encryption-State': enabled ? 'on' : 'off' });
	vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/encryption' || !enabled
		? Response.json({ encryption: null, reminders: [] }, { headers: headers() })
		: Response.json({ error: 'Unlock this vault', code: 'encryption_required' }, { status: 428, headers: headers() })));
	const api = makeApiFetch('session', vi.fn());
	for (let read = 0; read < 3; read++) expect((await api('/reminders/list?folderPath=Reminders')).status).toBe(200);
	// Before: one /encryption probe per request in an unencrypted vault.
	expect(prepareReminderEncryption).toHaveBeenCalledOnce();
	enabled = true;
	await expect(api('/reminders/list?folderPath=Reminders')).rejects.toThrow('vault encryption changed');
	// The 428 retried once after a fresh probe instead of trusting the cached state.
	expect(prepareReminderEncryption).toHaveBeenCalledTimes(2);
});

it('reuses the startup probe in the app client instead of probing again', async () => {
	const fetchMock = vi.fn(async (_path: string) => Response.json({ encryption: null, reminders: [] }, { headers: { 'X-Crate-Encryption-State': 'off' } }));
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal('localStorage', { getItem: () => 'startup' });
	await makeApiFetch('startup', vi.fn()).ready();
	const app = makeApiFetch('startup', vi.fn());
	expect((await app('/reminders/list?folderPath=Reminders')).status).toBe(200);
	// Before: bootstrap and app clients each probed, adding a serial round trip.
	expect(prepareReminderEncryption).toHaveBeenCalledOnce();
	expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/encryption', '/reminders/list?folderPath=Reminders']);
	// Another credential never inherits this confirmation.
	await makeApiFetch('other', vi.fn())('/reminders/list?folderPath=Reminders');
	expect(prepareReminderEncryption).toHaveBeenCalledTimes(2);
});

it.each([401, 403, 423, 428])('probes again after a %i instead of trusting an earlier unencrypted response', async status => {
	let refused: number | null = null;
	const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => refused
		? Response.json({ error: 'Refused' }, { status: refused })
		: Response.json({ encryption: null, success: true }, { headers: { 'X-Crate-Encryption-State': 'off' } }));
	vi.stubGlobal('fetch', fetchMock);
	const api = makeApiFetch('session', vi.fn());
	await api('/reminders/update', { method: 'POST', body: 'Plain' });
	// Another device turned encryption on and revoked or locked this credential.
	refused = status;
	await api('/reminders/update', { method: 'POST', body: 'Raced' }).catch(() => undefined);
	await api('/reminders/update', { method: 'POST', body: 'Later' }).catch(() => undefined);
	// Before: the refusal carried no state, so "off" stayed cached and the next change sent plaintext.
	expect(prepareReminderEncryption).toHaveBeenCalledTimes(2);
	const later = fetchMock.mock.calls.findIndex(([, init]) => init?.body === 'Later');
	if (status === 401) expect(later).toBe(-1);
	else expect(fetchMock.mock.calls[later - 1]?.[0]).toBe('/encryption');
});

it('trusts an unencrypted response only briefly before sending a change', async () => {
	let now = 1_000;
	const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
	const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ encryption: null, reminders: [] }, { headers: { 'X-Crate-Encryption-State': 'off' } }));
	vi.stubGlobal('fetch', fetchMock);
	const api = makeApiFetch('session', vi.fn());
	await api('/reminders/update', { method: 'POST', body: 'Plain' });
	now += 29_000;
	await api('/reminders/update', { method: 'POST', body: 'Recent' });
	now += 60_000;
	// Reads send nothing private and keep trusting the verdict.
	await api('/reminders/list?folderPath=Reminders');
	expect(prepareReminderEncryption).toHaveBeenCalledOnce();
	now += 31_000;
	await api('/reminders/update', { method: 'POST', body: 'Idle' });
	// Before: the verdict never expired, so a change after any idle period skipped the probe.
	expect(prepareReminderEncryption).toHaveBeenCalledTimes(2);
	expect(fetchMock.mock.calls.map(([path]) => path).slice(-2)).toEqual(['/encryption', '/reminders/update']);
	clock.mockRestore();
});

it('does not let a response already in flight restore a dropped unencrypted verdict', async () => {
	let releaseSlow!: () => void;
	const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
	const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
		// The server handled this change before revoking the credential; its response arrives last.
		if (init?.body === 'Slow') { await slow; return Response.json({ success: true }, { headers: { 'X-Crate-Encryption-State': 'off' } }); }
		if (init?.body === 'Raced') return Response.json({ error: 'Revoked' }, { status: 401 });
		return Response.json({ encryption: null, success: true }, { headers: { 'X-Crate-Encryption-State': 'off' } });
	});
	vi.stubGlobal('fetch', fetchMock);
	const api = makeApiFetch('session', vi.fn());
	await api('/reminders/update', { method: 'POST', body: 'Plain' });
	const slowChange = api('/reminders/update', { method: 'POST', body: 'Slow' });
	await vi.waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.body === 'Slow')).toBe(true));
	await expect(api('/reminders/update', { method: 'POST', body: 'Raced' })).rejects.toThrow('Session expired');
	releaseSlow();
	await slowChange;
	await api('/reminders/update', { method: 'POST', body: 'Later' });
	expect(prepareReminderEncryption).toHaveBeenCalledTimes(2);
	expect(fetchMock.mock.calls.map(([path]) => path).slice(-2)).toEqual(['/encryption', '/reminders/update']);
});

it('switches to the folder the server moved this session to', async () => {
	const off = { 'X-Crate-Encryption-State': 'off' };
	vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/encryption' ? Response.json({ encryption: null }, { headers: off })
		: path.includes('Private') ? Response.json({ error: 'Forbidden' }, { status: 403, headers: off })
			: Response.json({ error: 'The reminders folder changed', code: 'reminders_folder_changed', folderPath: 'Tasks' }, { status: 403, headers: off })));
	const api = makeApiFetch('moved-session', vi.fn());
	await expect(api('/reminders/list?folderPath=Reminders')).rejects.toThrow('reminders folder changed in Obsidian');
	expect(adoptReminderFolder).toHaveBeenCalledWith('Tasks');
	// Other refusals reach the caller unchanged.
	expect((await api('/reminders/list?folderPath=Private')).status).toBe(403);
	expect(adoptReminderFolder).toHaveBeenCalledOnce();
});
