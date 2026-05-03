import { PWA_ASSET_VERSION } from '../pwa-version.gen';

export const SERVICE_WORKER_JS = `
const PWA_SHELL_CACHE = 'crate-reminders-shell-${PWA_ASSET_VERSION}';
const PWA_SHELL_URL = '/notifications';
const PWA_PRECACHE_URLS = [
	PWA_SHELL_URL,
	'/notifications/app.js?v=${PWA_ASSET_VERSION}',
	'/notifications/icon.svg?v=${PWA_ASSET_VERSION}',
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
				return Promise.all(cacheNames.map(function(cacheName) {
					if (cacheName === PWA_SHELL_CACHE || cacheName.indexOf('crate-reminders-shell-') !== 0) {
						return undefined;
					}
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

	if (event.request.mode === 'navigate' || url.pathname === PWA_SHELL_URL) {
		event.respondWith(
			fetch(event.request)
				.then(function(response) {
					if (response.ok && !url.search) {
						var cachedResponse = response.clone();
						event.waitUntil(caches.open(PWA_SHELL_CACHE).then(function(cache) {
							return cache.put(PWA_SHELL_URL, cachedResponse);
						}));
					}
					return response;
				})
				.catch(function() {
					return caches.match(PWA_SHELL_URL).then(function(cached) {
						return cached || Response.error();
					});
				})
		);
		return;
	}

	if (url.pathname === '/notifications/app.js' || url.pathname === '/notifications/icon.svg') {
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
	const data = event.data ? event.data.json() : {};
	event.waitUntil(
		self.registration.showNotification(data.title || 'Reminder', {
			body: data.body || '',
			tag: data.tag || 'crate-reminder',
			icon: '/notifications/icon.svg?v=${PWA_ASSET_VERSION}',
			data: {
				project: data.project || '',
				reminderId: data.reminderId || '',
			},
		})
	);
});

self.addEventListener('notificationclick', function(event) {
	event.notification.close();
	var project = (event.notification.data && event.notification.data.project) || '';
	var reminderId = (event.notification.data && event.notification.data.reminderId) || '';
	var params = new URLSearchParams();
	if (project) params.set('project', project);
	if (reminderId) params.set('reminderId', reminderId);
	var url = '/notifications' + (params.toString() ? '?' + params.toString() : '');
	event.waitUntil(clients.openWindow(url));
});

self.addEventListener('pushsubscriptionchange', function() {
	// Re-subscription is handled by the app the next time it opens.
});
\``;
