import { PWA_ASSET_VERSION } from '@/pwa/shell/version';

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
