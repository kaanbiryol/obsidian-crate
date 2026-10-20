import { receiveReadingShare } from '../shell/share-target';
import { decryptPushDisplay } from '../encrypted-push';
import type { ServiceWorkerConfig } from './config';

interface NotificationData {
	encrypted?: unknown;
	project?: string;
	reminderId?: string;
	navigate?: string;
}

interface PushNotification {
	title?: string;
	body?: string;
	navigate?: string;
	tag?: string;
	icon?: string;
	data?: NotificationData;
}

interface PushPayload extends PushNotification {
	notification?: PushNotification;
	project?: string;
	reminderId?: string;
}

/** Safari supplies a declarative Notification instead of PushMessageData. */
type DeclarativePushEvent = PushEvent & { notification?: PushNotification };
type NavigableNotificationOptions = NotificationOptions & { navigate?: string };

const HASHED_CHUNK = /^\/notifications\/assets\/chunk-[a-z0-9-]+\.js$/i;
const PRECACHE_CONCURRENCY = 4;

/** Register the complete runtime after the Worker supplies the final asset version. */
export function initialize(scope: ServiceWorkerGlobalScope, config: ServiceWorkerConfig): void {
	const shellCache = `crate-reminders-shell-${config.version}`;
	const shellUrl = '/notifications';
	const precacheUrls = [
		shellUrl,
		`/notifications/app.js?v=${config.version}`,
		`/notifications/theme-bootstrap.js?v=${config.version}`,
		`/notifications/crate-icon-192.png?v=${config.version}`,
		`/notifications/crate-icon-512.png?v=${config.version}`,
		`/notifications/crate-mark-256.png?v=${config.version}`,
		`/notifications/apple-touch-icon-180.png?v=${config.version}`,
		...config.chunkUrls,
	];

	scope.addEventListener('install', event => {
		event.waitUntil(caches.open(shellCache).then(async cache => {
			// Keep installation conditional on a complete shell and bound traffic.
			// A content-hashed chunk an earlier version cached is the same file.
			// Hashed and versioned URLs are immutable, so the page's HTTP cache may
			// satisfy them; only the unversioned shell must bypass it.
			const queue = [...precacheUrls];
			const next = async (): Promise<void> => {
				for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
					const cached = HASHED_CHUNK.test(url) ? await caches.match(url) : undefined;
					const response = cached ?? await (url === shellUrl ? fetch(url, { cache: 'reload' }) : fetch(url));
					if (!response.ok) {
						queue.length = 0;
						throw new Error('Offline asset unavailable: ' + url);
					}
					await cache.put(url, response);
				}
			};
			await Promise.all(Array.from({ length: PRECACHE_CONCURRENCY }, next));
		}));
	});

	// Unknown clients prevent collection; older open apps retain their lazy chunks.
	const clientVersions = new Map<string, string>();
	async function collectUnusedShellCaches(): Promise<void> {
		const clients = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
		if (clients.some(client => !clientVersions.has(client.id))) return;
		const active = new Set([shellCache]);
		clients.forEach(client => active.add('crate-reminders-shell-' + clientVersions.get(client.id)));
		const names = await caches.keys();
		await Promise.all(names.filter(name => name.startsWith('crate-reminders-shell-') && !active.has(name)).map(name => caches.delete(name)));
	}
	scope.addEventListener('message', event => {
		const data = event.data as { type?: string; version?: unknown } | null;
		if (data?.type === 'CRATE_ACTIVATE_UPDATE') {
			event.waitUntil(scope.skipWaiting());
		} else if (data?.type === 'CRATE_CLIENT_VERSION' && event.source && 'id' in event.source && typeof data.version === 'string') {
			clientVersions.set(event.source.id, data.version);
			event.waitUntil(collectUnusedShellCaches());
		}
	});
	scope.addEventListener('activate', event => {
		event.waitUntil(scope.clients.claim().then(collectUnusedShellCaches));
	});

	scope.addEventListener('fetch', event => {
		if (event.request.method === 'POST' && new URL(event.request.url).origin === scope.location.origin && new URL(event.request.url).pathname === '/notifications/share/reading') {
			event.respondWith(receiveReadingShare(event.request));
			return;
		}
		if (event.request.method !== 'GET') return;
		const url = new URL(event.request.url);
		if (url.origin !== scope.location.origin || !url.pathname.startsWith('/notifications')) return;
		if (url.pathname === shellUrl) {
			event.respondWith(caches.open(shellCache).then(cache => cache.match(shellUrl)).then(cached => {
				if (cached) return cached;
				return fetch(event.request).then(response => {
					if (response.ok && !url.search) {
						const cachedResponse = response.clone();
						event.waitUntil(caches.open(shellCache).then(cache => cache.put(shellUrl, cachedResponse)));
					}
					return response;
				});
			}).catch(() => Response.error()));
			return;
		}
		if (url.pathname === '/notifications/app.js'
			|| url.pathname.startsWith('/notifications/assets/')
			|| url.pathname === '/notifications/theme-bootstrap.js'
			|| url.pathname === '/notifications/icon.svg'
			|| url.pathname === '/notifications/crate-icon-192.png'
			|| url.pathname === '/notifications/crate-icon-512.png'
			|| url.pathname === '/notifications/crate-mark-256.png'
			|| url.pathname === '/notifications/apple-touch-icon-180.png') {
			event.respondWith(caches.match(event.request).then(cached => {
				if (cached) return cached;
				return fetch(event.request).then(response => {
					if (response.ok) {
						const cachedResponse = response.clone();
						event.waitUntil(caches.open(shellCache).then(cache => cache.put(event.request, cachedResponse)));
					}
					return response;
				});
			}));
		}
	});

	scope.addEventListener('push', (event: DeclarativePushEvent) => {
		let payload: PushPayload = {};
		try { payload = (event.data?.json() as PushPayload | null) || {}; } catch { /* Show a generic reminder for malformed payloads. */ }
		const notification = event.notification || payload.notification || payload;
		const data = notification.data || {};
		event.waitUntil((async () => {
			const display = data.encrypted ? await decryptPushDisplay(data.encrypted) : null;
			const options: NavigableNotificationOptions = {
				body: display ? display.body : data.encrypted ? 'Open Crate to view your reminder' : notification.body || '',
				// Safari requires this when replacing a declarative notification.
				navigate: notification.navigate || undefined,
				tag: notification.tag || 'crate-reminder',
				icon: notification.icon || `/notifications/crate-icon-192.png?v=${config.version}`,
				data: {
					project: data.project || payload.project || '',
					reminderId: data.reminderId || payload.reminderId || '',
					navigate: notification.navigate || '',
				},
			};
			return scope.registration.showNotification(display ? display.title : data.encrypted ? 'Crate reminder' : notification.title || 'Reminder', options);
		})());
	});

	async function focusOrOpenNotificationTarget(url: string): Promise<WindowClient | null> {
		const clients = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
		for (const client of clients) {
			const clientUrl = new URL(client.url);
			if (clientUrl.pathname !== shellUrl && !clientUrl.pathname.startsWith(shellUrl + '/')) continue;
			try { return await (await client.navigate(url) || client).focus(); }
			catch { return client.focus(); }
		}
		return scope.clients.openWindow(url);
	}

	scope.addEventListener('notificationclick', event => {
		event.notification.close();
		const data = (event.notification.data as NotificationData | null) || {};
		const params = new URLSearchParams();
		if (data.project) params.set('project', data.project);
		if (data.reminderId) params.set('reminderId', data.reminderId);
		const url = data.navigate || '/notifications' + (params.toString() ? '?' + params.toString() : '');
		event.waitUntil(focusOrOpenNotificationTarget(url));
	});

	scope.addEventListener('pushsubscriptionchange', () => {
		// Re-subscription is handled by the app the next time it opens.
	});
}
