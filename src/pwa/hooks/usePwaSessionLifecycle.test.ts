import { describe, expect, it, vi } from 'vitest';
import { performPwaLogout } from './usePwaSessionLifecycle';

describe('performPwaLogout', () => {
	it('clears the local session after successful remote cleanup', async () => {
		const disablePushNotifications = vi.fn().mockResolvedValue(undefined);
		const apiFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		const clearLocalSession = vi.fn();

		const remoteCleanupFailed = await performPwaLogout({
			apiFetch,
			clearLocalSession,
			disablePushNotifications,
		});

		expect(remoteCleanupFailed).toBe(false);
		expect(disablePushNotifications).toHaveBeenCalledOnce();
		expect(apiFetch).toHaveBeenCalledWith('/auth/session', { method: 'DELETE' });
		expect(clearLocalSession).toHaveBeenCalledOnce();
	});

	it('still revokes the session and clears local data when push cleanup fails', async () => {
		const disablePushNotifications = vi.fn().mockRejectedValue(new Error('offline'));
		const apiFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		const clearLocalSession = vi.fn();

		const remoteCleanupFailed = await performPwaLogout({
			apiFetch,
			clearLocalSession,
			disablePushNotifications,
		});

		expect(remoteCleanupFailed).toBe(true);
		expect(apiFetch).toHaveBeenCalledOnce();
		expect(clearLocalSession).toHaveBeenCalledOnce();
	});

	it('clears local data when the remote session cannot be revoked', async () => {
		const clearLocalSession = vi.fn();

		const remoteCleanupFailed = await performPwaLogout({
			apiFetch: vi.fn().mockRejectedValue(new Error('offline')),
			clearLocalSession,
			disablePushNotifications: vi.fn().mockResolvedValue(undefined),
		});

		expect(remoteCleanupFailed).toBe(true);
		expect(clearLocalSession).toHaveBeenCalledOnce();
	});
});

 it('clears local state even when remote cleanup throws synchronously', async () => {
  const clearLocalSession = vi.fn(); const apiFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  expect(await performPwaLogout({apiFetch, clearLocalSession, disablePushNotifications: () => { throw new Error('Unavailable'); }})).toBe(true);
  expect(clearLocalSession).toHaveBeenCalledOnce(); expect(apiFetch).toHaveBeenCalledOnce();
 });
 it('clears local state before a delayed revocation completes', async () => {
  let resolve!: (value: Response) => void;
  const clearLocalSession = vi.fn();
  const logout = performPwaLogout({apiFetch: () => new Promise(done => { resolve = done; }), clearLocalSession, disablePushNotifications: async () => {}});
  expect(clearLocalSession).toHaveBeenCalledOnce(); resolve(new Response(null, {status: 204}));
  expect(await logout).toBe(false);
 });
