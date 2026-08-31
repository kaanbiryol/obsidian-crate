import { PWA_ASSET_VERSION } from '../pwa-version';
import { PWA_CLIENT_ASSETS } from '../pwa-client-bundle';

const pwaClientChunkUrls = Object.keys(PWA_CLIENT_ASSETS)
	.filter(fileName => fileName !== 'app.js')
	.map(fileName => `/notifications/assets/${fileName}`);

export const SERVICE_WORKER_JS = `
const PWA_SHELL_CACHE = 'crate-reminders-shell-${PWA_ASSET_VERSION}';
const PWA_SHELL_URL = '/notifications';
const PWA_PRECACHE_URLS = [
	PWA_SHELL_URL,
	'/notifications/app.js?v=${PWA_ASSET_VERSION}',
	'/notifications/theme-bootstrap.js?v=${PWA_ASSET_VERSION}',
	'/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}',
	'/notifications/crate-icon-512.png?v=${PWA_ASSET_VERSION}',
	'/notifications/crate-mark-256.png?v=${PWA_ASSET_VERSION}',
	'/notifications/apple-touch-icon-180.png?v=${PWA_ASSET_VERSION}',
	${pwaClientChunkUrls.map(url => `'${url}',`).join('\n\t')}
];

self.addEventListener('install', function(event) {
	event.waitUntil(
		caches.open(PWA_SHELL_CACHE)
			.then(function(cache) {
				return cache.addAll(PWA_PRECACHE_URLS);
			})
			.then(function() {
				return self.skipWaiting();
			})
	);
});

self.addEventListener('activate', function(event) {
	event.waitUntil(
		caches.keys()
			.then(function(cacheNames) {
				var previousShellCaches = cacheNames.filter(function(cacheName) {
					return cacheName !== PWA_SHELL_CACHE && cacheName.indexOf('crate-reminders-shell-') === 0;
				});
				return Promise.all(previousShellCaches.slice(0, -1).map(function(cacheName) {
					return caches.delete(cacheName);
				}));
			})
			.then(function() {
				return self.clients.claim();
			})
	);
});

self.addEventListener('fetch', function(event) {
	if (event.request.method !== 'GET') return;

	var url = new URL(event.request.url);
	if (url.origin !== self.location.origin || url.pathname.indexOf('/notifications') !== 0) return;

	if (url.pathname === PWA_SHELL_URL) {
		event.respondWith(
			caches.open(PWA_SHELL_CACHE).then(function(cache) {
				return cache.match(PWA_SHELL_URL);
			}).then(function(cached) {
				if (cached) return cached;
				return fetch(event.request).then(function(response) {
					if (response.ok && !url.search) {
						var cachedResponse = response.clone();
						event.waitUntil(caches.open(PWA_SHELL_CACHE).then(function(cache) {
							return cache.put(PWA_SHELL_URL, cachedResponse);
						}));
					}
					return response;
				});
			}).catch(function() {
				return Response.error();
			})
		);
		return;
	}

	if (
		url.pathname === '/notifications/app.js'
		|| url.pathname.indexOf('/notifications/assets/') === 0
		|| url.pathname === '/notifications/theme-bootstrap.js'
		|| url.pathname === '/notifications/icon.svg'
		|| url.pathname === '/notifications/crate-icon-192.png'
		|| url.pathname === '/notifications/crate-icon-512.png'
		|| url.pathname === '/notifications/crate-mark-256.png'
		|| url.pathname === '/notifications/apple-touch-icon-180.png'
	) {
		event.respondWith(
			caches.match(event.request).then(function(cached) {
				if (cached) return cached;
				return fetch(event.request).then(function(response) {
					if (response.ok) {
						var cachedResponse = response.clone();
						event.waitUntil(caches.open(PWA_SHELL_CACHE).then(function(cache) {
							return cache.put(event.request, cachedResponse);
						}));
					}
					return response;
				});
			})
		);
	}
});

self.addEventListener('push', function(event) {
	var payload = event.data ? event.data.json() : {};
	var notification = payload.notification || payload;
	var notificationData = notification.data || {};
	event.waitUntil(
		self.registration.showNotification(notification.title || 'Reminder', {
			body: notification.body || '',
			tag: notification.tag || 'crate-reminder',
			icon: notification.icon || '/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}',
			data: {
				project: notificationData.project || payload.project || '',
				reminderId: notificationData.reminderId || payload.reminderId || '',
				navigate: notification.navigate || '',
			},
		})
	);
});

function focusOrOpenNotificationTarget(url) {
	return clients.matchAll({ type: 'window', includeUncontrolled: true })
		.then(function(windowClients) {
			for (var index = 0; index < windowClients.length; index++) {
				var client = windowClients[index];
				var clientUrl = new URL(client.url);
				if (clientUrl.pathname !== PWA_SHELL_URL && clientUrl.pathname.indexOf(PWA_SHELL_URL + '/') !== 0) {
					continue;
				}

				return client.navigate(url)
					.then(function(navigatedClient) {
						return (navigatedClient || client).focus();
					})
					.catch(function() {
						return client.focus();
					});
			}

			return clients.openWindow(url);
		});
}

self.addEventListener('notificationclick', function(event) {
	event.notification.close();
	var notificationData = event.notification.data || {};
	var project = notificationData.project || '';
	var reminderId = notificationData.reminderId || '';
	var params = new URLSearchParams();
	if (project) params.set('project', project);
	if (reminderId) params.set('reminderId', reminderId);
	var url = notificationData.navigate || '/notifications' + (params.toString() ? '?' + params.toString() : '');
	event.waitUntil(focusOrOpenNotificationTarget(url));
});

self.addEventListener('pushsubscriptionchange', function() {
	// Re-subscription is handled by the app the next time it opens.
});
`;
