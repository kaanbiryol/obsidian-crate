import { afterEach, expect, it, vi } from 'vitest';
import { makeApiFetch } from './api';
import { AUTH_TOKEN_KEY } from './config';
import { invalidatePwaSession } from './session-generation';
import { performPwaLogout } from './hooks/usePwaSessionLifecycle';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('dispatches the captured revocation after local logout while fencing ordinary writes', async () => {
	const values = new Map([[AUTH_TOKEN_KEY, 'old-token']]);
	vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null });
	const network = vi.fn(async (path: string, init?: RequestInit) => {
		if (path === '/auth/session') {
			expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer old-token');
			return new Response(null, { status: 204 });
		}
		return new Response(JSON.stringify({ service: 'crate', serverVersion: '0.1.0', protocol: { current: 3, oldestCompatible: 3 }, capabilities: [] }));
	});
	vi.stubGlobal('fetch', network);
	const apiFetch = makeApiFetch('old-token', vi.fn());
	const ordinary = apiFetch('/reminders/create', { method: 'POST' }).catch((error: unknown) => error);
	const failed = await performPwaLogout({ apiFetch, disablePushNotifications: async () => {}, clearLocalSession: () => { invalidatePwaSession(); values.set(AUTH_TOKEN_KEY, 'new-token'); } });
	expect(failed).toBe(false);
	expect(await ordinary).toBeInstanceOf(Error);
	expect(network.mock.calls.filter(([path]) => path === '/auth/session')).toHaveLength(1);
	expect(network.mock.calls.some(([path]) => path === '/reminders/create')).toBe(false);
	await expect(apiFetch('/auth/session', { method: 'DELETE' })).rejects.toThrow('Session changed');
});
