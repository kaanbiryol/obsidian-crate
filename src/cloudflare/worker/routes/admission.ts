import { apiRoutePolicy } from './policy';
import { DEVELOPMENT_SHORTCUT_FILE_PATH, DEVELOPMENT_SHORTCUT_PATH } from '../../../reading/shortcut';
import { DEVELOPMENT_SHORTCUT } from '../reading/development-shortcut';

/** Public assets admitted before authentication, database metering or coordinator work. */
export const PUBLIC_ASSET_PATHS: ReadonlySet<string> = new Set([
	'/', '/.well-known/crate', '/notifications',
	...['app.js', 'theme-bootstrap.js', 'sw.js', 'manifest.json', 'version.json', 'icon.svg',
		'crate-icon-192.png', 'crate-icon-512.png', 'crate-mark-256.png', 'apple-touch-icon-180.png',
		'open-obsidian', 'open-obsidian.js', 'save-reading', 'save-reading.js'].map(name => `/notifications/${name}`),
	// Only development Workers embed a locally signed shortcut.
	...(DEVELOPMENT_SHORTCUT ? [DEVELOPMENT_SHORTCUT_PATH, DEVELOPMENT_SHORTCUT_FILE_PATH] : []),
]);

export function requestAdmissionKind(request: Request): 'asset' | 'api' | 'unknown' {
	const path = new URL(request.url).pathname;
	if (request.method === 'GET' && (PUBLIC_ASSET_PATHS.has(path) || path.startsWith('/notifications/assets/'))) return 'asset';
	return apiRoutePolicy(path, request.method) ? 'api' : 'unknown';
}
