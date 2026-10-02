/** Cheap routing before authentication, database metering, or coordinator work.
 * Keep this inventory aligned with the route handlers (covered by contract tests).
 */
const assets = new Set([
	'/', '/.well-known/crate', '/notifications',
	...['app.js', 'theme-bootstrap.js', 'sw.js', 'manifest.json', 'version.json', 'icon.svg',
		'crate-icon-192.png', 'crate-icon-512.png', 'crate-mark-256.png', 'apple-touch-icon-180.png',
		'open-obsidian', 'open-obsidian.js', 'save-reading', 'save-reading.js'].map(name => `/notifications/${name}`),
]);
const api = new Set([
	...['', '/capture-recovery', '/upload-receipt', '/deletion-precondition', '/folders', '/reset', '/conversion', '/conversion/file', '/conversion/settings', '/conversion/checkpoints'].map(suffix => `GET /encryption${suffix}`),
	...['/metadata', '/reset', '/conversion', '/conversion/finish'].map(suffix => `POST /encryption${suffix}`),
	...['file', 'settings', 'receipt', 'checkpoint', 'reading-capture'].map(name => `PUT /encryption/conversion/${name}`),
	...['files', 'file', 'receipt'].map(name => `GET /reminders/encrypted-${name}`),
	'POST /reminders/encrypted-commit',
	'GET /reading/encryption', 'GET /reading/encrypted-receipt',
	'GET /reading/encrypted-files', 'GET /reading/encrypted-file', 'POST /reading/encrypted-commit',
	'GET /health', 'GET /diagnostics', 'GET /settings', 'PUT /settings', 'GET /features', 'POST /features',
	'GET /auth/tokens', 'DELETE /auth/tokens', 'DELETE /auth/session', 'POST /links/title',
	...['checkpoints', 'checkpoint', 'checkpoint-file', 'check', 'changes', 'manifest', 'download', 'version-preview', 'versions'].map(name => `GET /sync/${name}`),
	...['checkpoints', 'import', 'import/complete', 'import/readiness', 'import/prune', 'import/upload', 'metadata', 'delete', 'batch-upload', 'batch-download', 'batch-delete', 'restore-version'].map(name => `POST /sync/${name}`),
	'PUT /sync/upload', 'PUT /sync/import/upload',
	...['retry', 'reminders-exchange', 'reminders-enrollment-token', 'subscribe', 'test', 'share/reading'].map(name => `POST /notifications/${name}`),
	'GET /notifications/vapid-public-key', 'GET /notifications/subscriptions', 'DELETE /notifications/subscribe',
	'GET /reminders/list', 'DELETE /reminders/delete',
	...['create', 'update', 'set-completed', 'reorder'].map(name => `POST /reminders/${name}`),
	...['GET', 'POST', 'PUT'].map(method => `${method} /reminders/notification-policy`),
	...['exchange', 'handoff', 'shortcut-exchange', 'shortcut-pairing', 'access', 'prepare', 'capture', 'update', 'retry', 'fetching', 'policy'].map(name => `POST /reading/${name}`),
	...['policy', 'fetching', 'session', 'list', 'item'].map(name => `GET /reading/${name}`),
]);

export function requestAdmissionKind(request: Request): 'asset' | 'api' | 'unknown' {
	const path = new URL(request.url).pathname;
  if (request.method === 'POST' && /^\/reading\/shortcut\/v(?:0|[1-9]\d{0,2})\/(prepare|exchange)$/.test(path)) return 'api';
	if (request.method === 'GET' && (assets.has(path) || path.startsWith('/notifications/assets/'))) return 'asset';
	return api.has(`${request.method} ${path}`) ? 'api' : 'unknown';
}
