import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeApiFetch } from './api-fetch';
import { prepareReminderEncryption } from './encryption-session';
import { invalidatePwaSession } from '../session-generation';
import type { ApiFetch } from '../types';

vi.mock('./encryption-session', () => ({
	prepareReminderEncryption: vi.fn(async (_token: string, rawFetch: ApiFetch) => { await rawFetch('/encryption'); return null; }),
	reminderEncryptionSnapshot: () => ({ status: 'unencrypted' }),
}));

beforeEach(() => {
	vi.stubGlobal('localStorage', { getItem: () => 'session' });
	vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
	vi.stubGlobal('navigator', { userAgent: 'Test Browser', maxTouchPoints: 0 });
});
afterEach(() => { invalidatePwaSession(); vi.unstubAllGlobals(); vi.mocked(prepareReminderEncryption).mockClear(); });

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
