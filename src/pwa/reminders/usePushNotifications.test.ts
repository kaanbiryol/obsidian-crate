import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { usePushNotifications } from './usePushNotifications';

const subscription = { toJSON: () => ({ endpoint: 'https://push.example/one', keys: { p256dh: 'p', auth: 'a' } }) };
const manager = vi.hoisted(() => ({ value: null as object | null }));
vi.mock('../config', () => ({ detectDeviceName: () => 'Test device', isIosOrIpados: () => false, isStandaloneApp: () => true }));
vi.mock('../service-worker-registration', () => ({ getPwaPushManager: async () => manager.value, urlBase64ToUint8Array: () => new Uint8Array() }));

it('reveals content for a granted subscription before the server confirms it', async () => {
	vi.stubGlobal('Notification', { permission: 'granted' });
	manager.value = { getSubscription: async () => subscription, permissionState: async () => 'granted' };
	let respond!: (response: Response) => void;
	const apiFetch = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; }));
	const hook = renderHook(() => usePushNotifications({ authToken: 'token', apiFetch, prepareSession: async () => undefined, showToast: vi.fn() }));

	let refresh!: Promise<void>;
	await act(async () => { refresh = hook.current.refreshPushState(); await Promise.resolve(); });
	await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
	expect(hook.current.initialCheckComplete).toBe(true);
	expect(hook.current.push.phase).toBe('checking');

	await act(async () => {
		respond(new Response(JSON.stringify({ id: 'sub', notificationsEnabled: true })));
		await refresh;
	});
	expect(hook.current.push.phase).toBe('enabled');
});
