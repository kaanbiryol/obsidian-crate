import { registerPwaServiceWorker } from '../service-worker-registration';
import { reminderEncryptionSnapshot } from './encryption-session';

type WindowWithPushManager = Window & {
	readonly pushManager?: PushManager;
};

interface PwaPushManagerOptions {
	windowPushManager?: PushManager | null;
	registerServiceWorker?: () => Promise<ServiceWorkerRegistration | null>;
}

function getWindowPushManager(): PushManager | null {
	if (typeof window === 'undefined') return null;
	return (window as WindowWithPushManager).pushManager ?? null;
}

export async function getPwaPushManager({
	windowPushManager = getWindowPushManager(),
	registerServiceWorker = registerPwaServiceWorker,
}: PwaPushManagerOptions = {}): Promise<PushManager | null> {
	if (windowPushManager && reminderEncryptionSnapshot().status === 'unencrypted') return windowPushManager;
	const registration = await registerServiceWorker();
	return registration?.pushManager ?? null;
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
	const padding = '='.repeat((4 - base64String.length % 4) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
	return outputArray;
}
