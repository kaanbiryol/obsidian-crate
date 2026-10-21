import { PWA_ASSET_VERSION } from '@/pwa/shell/version';
import { reminderEncryptionSnapshot } from './reminders/encryption-session';

export async function registerPwaServiceWorker(): Promise<ServiceWorkerRegistration | null> {
	if (!('serviceWorker' in navigator)) return null;
	const existing = await navigator.serviceWorker.getRegistration('/notifications');
	// Startup and push checks reuse the registration even after another tab has
	// activated a newer shell. Only the update flow chooses a replacement version.
	if (existing && [existing.active, existing.waiting, existing.installing].some(worker => worker && worker.state !== 'redundant')) return existing;
	return navigator.serviceWorker.register(`/notifications/sw.js?v=${PWA_ASSET_VERSION}`, {
		scope: '/notifications',
	});
}

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
