import { useCallback, useState } from 'react';
import { detectDeviceName, isIosOrIpados, isStandaloneApp } from '../config';
import { getPwaPushManager, urlBase64ToUint8Array } from '../api';
import type { ApiFetch, PushState, ShowToast } from '../types';

export function usePushNotifications({
	apiFetch,
	showToast,
}: {
	apiFetch: ApiFetch;
	showToast: ShowToast;
}): {
	push: PushState;
	refreshPushState: () => Promise<void>;
	enablePushNotifications: () => Promise<void>;
	disablePushNotifications: () => Promise<void>;
} {
	const [push, setPush] = useState<PushState>({ supported: false, subscribed: false, status: null });

	const refreshPushState = useCallback(async () => {
		try {
			const standalone = isStandaloneApp();
			if (!standalone && isIosOrIpados()) {
				setPush({
					supported: true,
					subscribed: false,
					status: 'Add Crate to your Home Screen as a web app to enable notifications on iPhone and iPad.',
				});
				return;
			}

			const pushManager = await getPwaPushManager();
			if (!pushManager) {
				setPush({ supported: false, subscribed: false, status: 'Push notifications are not supported in this browser.' });
				return;
			}
			const subscription = await pushManager.getSubscription();
			setPush({
				supported: true,
				subscribed: !!subscription,
				status: subscription ? 'Notifications enabled on this device.' : null,
			});
		} catch (pushError) {
			const message = pushError instanceof Error ? pushError.message : String(pushError);
			setPush({ supported: false, subscribed: false, status: `Notification setup failed: ${message}` });
		}
	}, []);

	const enablePushNotifications = useCallback(async () => {
		try {
			const pushManager = await getPwaPushManager();
			if (!pushManager) throw new Error('Push is not supported on this device.');
			const keyResponse = await fetch('/notifications/vapid-public-key');
			const { publicKey } = await keyResponse.json() as { publicKey?: string };
			if (!publicKey) throw new Error('Missing VAPID public key');
			const subscription = await pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(publicKey),
			});
			const body = subscription.toJSON();
			const response = await apiFetch('/notifications/subscribe', {
				method: 'POST',
				body: JSON.stringify({
					endpoint: body.endpoint,
					keys: body.keys,
					deviceName: detectDeviceName(),
				}),
			});
			if (!response.ok) throw new Error(await response.text());
			setPush({ supported: true, subscribed: true, status: 'Notifications enabled on this device.' });
			showToast('success', 'Notifications enabled');
		} catch (pushError) {
			const message = pushError instanceof Error ? pushError.message : String(pushError);
			setPush((current) => ({ ...current, status: message }));
			showToast('error', message);
		}
	}, [apiFetch, showToast]);

	const disablePushNotifications = useCallback(async () => {
		const pushManager = await getPwaPushManager();
		const subscription = await pushManager?.getSubscription();
		if (!subscription) return;

		// Logout revokes the session and its owned server subscriptions together.
		// This cleanup is browser-local and remains valid after session clearing.
		if (!await subscription.unsubscribe()) throw new Error('Browser push cleanup failed');
		setPush({ supported: true, subscribed: false, status: null });
	}, []);

	return { push, refreshPushState, enablePushNotifications, disablePushNotifications };
}
