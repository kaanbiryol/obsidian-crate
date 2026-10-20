import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeApiFetch } from './api';
import { preparePwaEncryption } from './encryption/encryption-session';
import { invalidatePwaSession } from './session-generation';
import type { ApiFetch } from './types';

vi.mock('./encryption/encryption-session', () => ({
	preparePwaEncryption: vi.fn(async (_token: string, rawFetch: ApiFetch) => { await rawFetch('/encryption'); return null; }),
	encryptionSnapshot: () => ({ status: 'legacy' }),
}));

beforeEach(() => {
	vi.stubGlobal('localStorage', { getItem: () => 'session' });
	vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
	vi.stubGlobal('navigator', { userAgent: 'Test Browser', maxTouchPoints: 0 });
});
afterEach(() => { invalidatePwaSession(); vi.unstubAllGlobals(); vi.mocked(preparePwaEncryption).mockClear(); });

it('probes encryption once while server responses confirm the vault is unencrypted', async () => {
	let enabled = false;
	const headers = () => ({ 'X-Crate-Encryption-State': enabled ? 'on' : 'off' });
	vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/encryption' || !enabled
		? Response.json({ encryption: null, reminders: [] }, { headers: headers() })
		: Response.json({ error: 'Unlock this vault', code: 'encryption_required' }, { status: 428, headers: headers() })));
	const api = makeApiFetch('session', vi.fn());
	for (let read = 0; read < 3; read++) expect((await api('/reminders/list?folderPath=Reminders')).status).toBe(200);
	// Before: one /encryption probe per request in an unencrypted vault.
	expect(preparePwaEncryption).toHaveBeenCalledOnce();
	enabled = true;
	await expect(api('/reminders/list?folderPath=Reminders')).rejects.toThrow('encrypted folder changed');
	// The 428 retried once after a fresh probe instead of trusting the cached state.
	expect(preparePwaEncryption).toHaveBeenCalledTimes(2);
});
