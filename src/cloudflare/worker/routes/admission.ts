import { apiRoutePolicy } from './policy';

/** Public assets admitted before authentication, database metering or coordinator work. */
const assets = new Set([
	'/', '/.well-known/crate', '/notifications',
	...['app.js', 'theme-bootstrap.js', 'sw.js', 'manifest.json', 'version.json', 'icon.svg',
		'crate-icon-192.png', 'crate-icon-512.png', 'crate-mark-256.png', 'apple-touch-icon-180.png',
		'open-obsidian', 'open-obsidian.js', 'save-reading', 'save-reading.js'].map(name => `/notifications/${name}`),
]);

export function requestAdmissionKind(request: Request): 'asset' | 'api' | 'unknown' {
	const path = new URL(request.url).pathname;
	if (request.method === 'GET' && (assets.has(path) || path.startsWith('/notifications/assets/'))) return 'asset';
	return apiRoutePolicy(path, request.method) ? 'api' : 'unknown';
}
