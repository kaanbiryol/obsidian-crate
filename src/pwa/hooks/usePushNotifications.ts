import { useCallback, useEffect, useRef, useState } from 'react';
import { detectDeviceName, isIosOrIpados, isStandaloneApp } from '../config';
import { getPwaPushManager, urlBase64ToUint8Array } from '../api';
import { capturePwaSession } from '../session-generation';
import type { ApiFetch, PushState, ShowToast } from '../types';

const CHECKING: PushState = { phase: 'checking', status: 'Checking notification registration…' };
const ENABLED: PushState = { phase: 'enabled', status: 'Notifications enabled on this device.' };
const BLOCKED: PushState = { phase: 'blocked', status: 'Notifications are blocked. Allow them in browser settings, then reopen Crate.' };

async function notificationPermission(manager: PushManager): Promise<PermissionState> {
	const permission = typeof Notification !== 'undefined'
		? Notification.permission === 'default' ? 'prompt' : Notification.permission
		: await manager.permissionState({ userVisibleOnly: true });
	if (permission !== 'granted' && permission !== 'denied' && permission !== 'prompt') throw new Error('Could not confirm browser notification permission.');
	return permission;
}

export function usePushNotifications({ authToken, apiFetch, showToast }: {
	authToken: string | null;
	apiFetch: ApiFetch;
	showToast: ShowToast;
}): {
	push: PushState;
	refreshPushState: () => Promise<void>;
	enablePushNotifications: () => Promise<void>;
	disablePushNotifications: () => Promise<void>;
} {
	const [state, setState] = useState<{ authToken: string | null; push: PushState }>({ authToken, push: CHECKING });
	const sequence = useRef(0);
	const inFlight = useRef<{ authToken: string; promise: Promise<void> } | null>(null);

	const reconcile = useCallback((enable: boolean): Promise<void> => {
		if (!authToken) return Promise.resolve();
		if (inFlight.current?.authToken === authToken) return inFlight.current.promise;
		const operation = ++sequence.current;
		const sessionCurrent = capturePwaSession();
		const isCurrent = () => operation === sequence.current && sessionCurrent();
		const update = (push: PushState) => { if (isCurrent()) setState({ authToken, push }); };
		update(CHECKING);
		const promise = (async () => {
			try {
				if (!isStandaloneApp() && isIosOrIpados()) {
					update({ phase: 'install', status: 'Add Crate to your Home Screen as a web app to enable notifications on iPhone and iPad.' });
					return;
				}
				const manager = await getPwaPushManager();
				if (!isCurrent()) return;
				if (!manager) {
					update({ phase: 'unsupported', status: 'Push notifications are not supported in this browser.' });
					return;
				}
				const permission = await notificationPermission(manager);
				if (!isCurrent()) return;
				if (permission === 'denied') { update(BLOCKED); return; }
				let subscription = await manager.getSubscription();
				if (!isCurrent()) return;
				if ((!subscription || permission !== 'granted') && !enable) {
					update({ phase: 'off', status: null });
					return;
				}
				if (!subscription || permission !== 'granted') {
					const response = await fetch('/notifications/vapid-public-key', { signal: AbortSignal.timeout(30_000) });
					if (!response.ok) throw new Error('Could not load notification settings. Try again.');
					const { publicKey } = await response.json() as { publicKey?: string };
					if (!publicKey) throw new Error('Missing VAPID public key');
					if (!isCurrent()) return;
					subscription = await manager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
					if (!isCurrent()) return;
				}
				if (await notificationPermission(manager) !== 'granted') throw new Error('Notification permission was not granted. Check browser settings and retry.');
				const body = subscription.toJSON();
				// This owner-checked upsert also repairs an absent server row after
				// enrollment, a lost registration response, or backend restoration.
				const response = await apiFetch('/notifications/subscribe', {
					method: 'POST', body: JSON.stringify({ endpoint: body.endpoint, keys: body.keys, deviceName: detectDeviceName() }),
				});
				if (!response.ok) throw new Error(await response.text());
				const result = await response.json() as { id?: unknown };
				if (typeof result.id !== 'string' || !result.id) throw new Error('The server did not confirm notification registration.');
				// Provider permission and endpoints can change during a request.
				const currentSubscription = await manager.getSubscription();
				const currentBody = currentSubscription?.toJSON();
				const currentPermission = await notificationPermission(manager);
				if (!isCurrent()) return;
				if (currentPermission === 'denied') { update(BLOCKED); return; }
				if (currentPermission !== 'granted' || !currentBody || currentBody.endpoint !== body.endpoint
					|| currentBody.keys?.p256dh !== body.keys?.p256dh || currentBody.keys?.auth !== body.keys?.auth) {
					throw new Error('Browser notification settings changed. Retry to confirm registration.');
				}
				update(ENABLED);
				if (enable) showToast('success', 'Notifications enabled');
			} catch (error) {
				if (!isCurrent()) return;
				const message = error instanceof Error ? error.message : String(error);
				update({ phase: 'error', status: `Notifications are not confirmed. ${message}` });
				if (enable) showToast('error', message);
			}
		})().finally(() => { if (operation === sequence.current) inFlight.current = null; });
		inFlight.current = { authToken, promise };
		return promise;
	}, [authToken, apiFetch, showToast]);
	const refreshPushState = useCallback(() => reconcile(false), [reconcile]);
	const enablePushNotifications = useCallback(() => reconcile(true), [reconcile]);

	useEffect(() => {
		let disposed = false;
		let permission: PermissionStatus | undefined;
		const changed = () => { void refreshPushState(); };
		if (authToken) void navigator.permissions?.query({ name: 'notifications' }).then(result => {
			if (disposed) return;
			permission = result;
			permission.addEventListener('change', changed);
		}).catch(() => undefined);
		return () => { disposed = true; permission?.removeEventListener('change', changed); };
	}, [authToken, refreshPushState]);

	const disablePushNotifications = useCallback(async () => {
		const pending = inFlight.current?.promise;
		const operation = ++sequence.current;
		inFlight.current = null;
		await pending;
		if (operation !== sequence.current) return;
		const manager = await getPwaPushManager();
		const subscription = await manager?.getSubscription();
		if (operation !== sequence.current) return;
		// Logout revokes owned server rows even if browser cleanup fails.
		if (subscription && !await subscription.unsubscribe()) throw new Error('Browser push cleanup failed');
		if (operation === sequence.current) setState({ authToken: null, push: { phase: 'off', status: null } });
	}, []);

	return { push: state.authToken === authToken ? state.push : CHECKING, refreshPushState, enablePushNotifications, disablePushNotifications };
}
