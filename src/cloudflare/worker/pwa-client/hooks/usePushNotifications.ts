import { useCallback, useState } from 'react';
import { detectDeviceName, isStandaloneApp } from '../config';
import { registerPwaServiceWorker, urlBase64ToUint8Array } from '../api';
import type { PushState, ToastKind } from '../types';

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function usePushNotifications({
	apiFetch,
	showToast,
}: {
	apiFetch: ApiFetch;
	showToast: (kind: ToastKind, message: string) => void;
}): {
	push: PushState;
	refreshPushState: () => Promise<void>;
	enablePushNotifications: () => Promise<void>;
} {
	const [push, setPush] = useState<PushState>({ supported: false, subscribed: false, status: null });

	const refreshPushState = useCallback(async () => {
		const standalone = isStandaloneApp();
		const supported = 'serviceWorker' in navigator && 'PushManager' in window;
		if (!supported) {
			setPush({ supported: false, subscribed: false, status: 'Push notifications are not supported in this browser.' });
			return;
		}

		if (!standalone && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
			setPush({ supported: true, subscribed: false, status: 'Install this app on your home screen to enable push notifications on iOS.' });
			return;
		}

		const registration = await registerPwaServiceWorker();
		if (!registration) {
			setPush({ supported: false, subscribed: false, status: 'Push notifications are not supported in this browser.' });
			return;
		}
		const subscription = await registration.pushManager.getSubscription();
		setPush({
			supported: true,
			subscribed: !!subscription,
			status: subscription ? 'Notifications enabled on this device.' : null,
		});
	}, []);

	const enablePushNotifications = useCallback(async () => {
		try {
			if (!push.supported) throw new Error('Push is not supported on this device.');
			const registration = await registerPwaServiceWorker();
			if (!registration) throw new Error('Push is not supported on this device.');
			const keyResponse = await fetch('/notifications/vapid-public-key');
			const { publicKey } = await keyResponse.json() as { publicKey?: string };
			if (!publicKey) throw new Error('Missing VAPID public key');
			const subscription = await registration.pushManager.subscribe({
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
	}, [apiFetch, push.supported, showToast]);

	return { push, refreshPushState, enablePushNotifications };
}
