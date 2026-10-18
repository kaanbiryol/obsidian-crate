import type { AuthPrincipal } from '../authenticate';
import { READING_SHORTCUT_CONTRACT as shortcut } from '@/reading/shortcut';

type Scope = AuthPrincipal['scope'];
interface ApiRoutePolicy {
	readonly scopes: readonly Scope[];
	readonly execution?:
		| { readonly kind: 'coordinator'; readonly wake: boolean }
		| { readonly kind: 'reading-grant' }
		| { readonly kind: 'transfer'; readonly path: '/sync-upload' | '/sync-batch-upload' };
	readonly initializeProjection?: boolean;
}

const COORDINATOR = { kind: 'coordinator', wake: true } as const;
const READING_GRANT = { kind: 'reading-grant' } as const;

const VAULT: readonly Scope[] = ['vault'];
const REMINDERS: readonly Scope[] = ['vault', 'reminders'];
const LIBRARY: readonly Scope[] = ['vault', 'reminders', 'reading'];
const ALL_SCOPES: readonly Scope[] = ['vault', 'reminders', 'reading', 'reading_capture'];

/** Worker-local admission, token scope and execution policy.
 * Folder authority, feature state and encryption guards remain in the handlers.
 */
const routes: Readonly<Partial<Record<string, ApiRoutePolicy>>> = {
	'GET /encryption/pairing': { scopes: LIBRARY },
	'POST /encryption/pairing': { scopes: LIBRARY },
	'GET /encryption': { scopes: REMINDERS },
	'GET /encryption/upload-receipt': { scopes: VAULT },
	'GET /encryption/deletion-precondition': { scopes: VAULT },
	'GET /encryption/folders': { scopes: VAULT },
	'GET /encryption/reset': { scopes: VAULT, execution: COORDINATOR },
	'GET /encryption/conversion': { scopes: VAULT, execution: COORDINATOR },
	'GET /encryption/conversion/file': { scopes: VAULT, execution: COORDINATOR },
	'GET /encryption/conversion/settings': { scopes: VAULT, execution: COORDINATOR },
	'GET /encryption/conversion/checkpoints': { scopes: VAULT, execution: COORDINATOR },
	'GET /encryption/conversion/checkpoint': { scopes: VAULT, execution: COORDINATOR },
	'POST /encryption/metadata': { scopes: VAULT },
	'POST /encryption/reset': { scopes: VAULT, execution: COORDINATOR },
	'POST /encryption/conversion': { scopes: VAULT, execution: COORDINATOR },
	'POST /encryption/conversion/finish': { scopes: VAULT, execution: COORDINATOR },
	'PUT /encryption/conversion/file': { scopes: VAULT, execution: COORDINATOR },
	'PUT /encryption/conversion/settings': { scopes: VAULT, execution: COORDINATOR },
	'PUT /encryption/conversion/receipt': { scopes: VAULT, execution: COORDINATOR },
	'PUT /encryption/conversion/checkpoint': { scopes: VAULT, execution: COORDINATOR },
	'PUT /encryption/conversion/reading-capture': { scopes: VAULT, execution: COORDINATOR },
	'GET /reminders/encrypted-files': { scopes: REMINDERS },
	'GET /reminders/encrypted-file': { scopes: REMINDERS },
	'GET /reminders/encrypted-receipt': { scopes: REMINDERS },
	'POST /reminders/encrypted-commit': { scopes: REMINDERS, execution: COORDINATOR },
	'GET /reading/encryption': { scopes: LIBRARY, execution: COORDINATOR },
	'GET /reading/encrypted-receipt': { scopes: LIBRARY, execution: COORDINATOR },
	'GET /reading/encrypted-files': { scopes: LIBRARY, execution: COORDINATOR },
	'GET /reading/encrypted-file': { scopes: LIBRARY, execution: COORDINATOR },
	'POST /reading/encrypted-commit': { scopes: LIBRARY, execution: COORDINATOR },
	'GET /health': { scopes: REMINDERS },
	'GET /diagnostics': { scopes: VAULT },
	'GET /settings': { scopes: VAULT },
	'PUT /settings': { scopes: VAULT, execution: COORDINATOR },
	'GET /features': { scopes: LIBRARY },
	'POST /features': { scopes: VAULT, execution: COORDINATOR },
	'GET /auth/tokens': { scopes: VAULT },
	'DELETE /auth/tokens': { scopes: VAULT, execution: COORDINATOR },
	'DELETE /auth/session': { scopes: LIBRARY, execution: COORDINATOR },
	'POST /links/title': { scopes: REMINDERS },
	'GET /sync/checkpoints': { scopes: VAULT },
	'GET /sync/checkpoint': { scopes: VAULT },
	'GET /sync/checkpoint-file': { scopes: VAULT },
	'GET /sync/check': { scopes: VAULT, initializeProjection: true },
	'GET /sync/changes': { scopes: VAULT },
	'GET /sync/manifest': { scopes: VAULT, initializeProjection: true },
	'GET /sync/download': { scopes: VAULT },
	'GET /sync/version-preview': { scopes: VAULT },
	'GET /sync/versions': { scopes: VAULT },
	'POST /sync/checkpoints': { scopes: VAULT, execution: COORDINATOR },
	'POST /sync/import': { scopes: VAULT },
	'POST /sync/import/complete': { scopes: VAULT, execution: COORDINATOR },
	'POST /sync/import/readiness': { scopes: VAULT },
	'POST /sync/import/prune': { scopes: VAULT, execution: COORDINATOR },
	'POST /sync/import/upload': { scopes: VAULT },
	'POST /sync/metadata': { scopes: VAULT },
	'POST /sync/delete': { scopes: VAULT, execution: COORDINATOR },
	'POST /sync/batch-upload': { scopes: VAULT, execution: { kind: 'transfer', path: '/sync-batch-upload' } },
	'POST /sync/batch-download': { scopes: VAULT },
	'POST /sync/batch-delete': { scopes: VAULT, execution: COORDINATOR },
	'POST /sync/restore-version': { scopes: VAULT, execution: COORDINATOR },
	'PUT /sync/upload': { scopes: VAULT, execution: { kind: 'transfer', path: '/sync-upload' } },
	'PUT /sync/import/upload': { scopes: VAULT },
	'POST /notifications/retry': { scopes: VAULT, execution: COORDINATOR },
	'POST /notifications/reminders-exchange': { scopes: VAULT },
	'POST /notifications/reminders-enrollment-token': { scopes: VAULT, execution: COORDINATOR },
	'POST /notifications/subscribe': { scopes: REMINDERS, execution: COORDINATOR },
	'POST /notifications/test': { scopes: VAULT },
	'POST /notifications/share/reading': { scopes: VAULT },
	'GET /notifications/vapid-public-key': { scopes: VAULT },
	'GET /notifications/subscriptions': { scopes: VAULT },
	'DELETE /notifications/subscribe': { scopes: REMINDERS, execution: COORDINATOR },
	'GET /reminders/list': { scopes: REMINDERS, initializeProjection: true },
	'DELETE /reminders/delete': { scopes: REMINDERS, execution: COORDINATOR },
	'POST /reminders/create': { scopes: REMINDERS, execution: COORDINATOR },
	'POST /reminders/update': { scopes: REMINDERS, execution: COORDINATOR },
	'POST /reminders/set-completed': { scopes: REMINDERS, execution: COORDINATOR },
	'POST /reminders/reorder': { scopes: REMINDERS, execution: COORDINATOR },
	'GET /reminders/notification-policy': { scopes: VAULT },
	'POST /reminders/notification-policy': { scopes: VAULT, execution: COORDINATOR },
	'PUT /reminders/notification-policy': { scopes: VAULT, execution: COORDINATOR },
	'POST /reading/exchange': { scopes: VAULT, execution: READING_GRANT },
	'POST /reading/handoff': { scopes: VAULT, execution: READING_GRANT },
	'POST /reading/shortcut-pairing': { scopes: LIBRARY, execution: COORDINATOR },
	'POST /reading/access': { scopes: VAULT, execution: COORDINATOR },
	'POST /reading/capture': { scopes: ALL_SCOPES, execution: COORDINATOR },
	'POST /reading/update': { scopes: LIBRARY, execution: COORDINATOR },
	'POST /reading/retry': { scopes: LIBRARY, execution: COORDINATOR },
	'POST /reading/fetching': { scopes: LIBRARY, execution: COORDINATOR },
	'POST /reading/policy': { scopes: VAULT, execution: COORDINATOR },
	'GET /reading/policy': { scopes: VAULT, execution: COORDINATOR },
	'GET /reading/fetching': { scopes: LIBRARY, execution: COORDINATOR },
	'GET /reading/session': { scopes: LIBRARY, execution: COORDINATOR },
	'GET /reading/list': { scopes: LIBRARY, execution: COORDINATOR },
	'GET /reading/item': { scopes: LIBRARY, execution: COORDINATOR },
	[`POST ${shortcut.preparePath}`]: { scopes: ['reading_capture'], execution: COORDINATOR },
};

export function apiRoutePolicy(path: string, method: string): ApiRoutePolicy | undefined {
	const key = `${method} ${path}`;
	if (Object.hasOwn(routes, key)) return routes[key];
	// Older and newer transports must reach compatibility handling, including
	// the public one-use exchange, rather than failing admission with a 404.
	if (method === 'POST') {
		const legacyShortcut = /^\/reading\/shortcut\/v(?:0|[1-9]\d{0,2})\/(prepare|exchange)$/.exec(path);
		if (legacyShortcut) return { scopes: VAULT, execution: legacyShortcut[1] === 'exchange' ? READING_GRANT : COORDINATOR };
	}
	return undefined;
}
