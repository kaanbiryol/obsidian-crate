import type { AuthPrincipal } from '../authenticate';
import { READING_SHORTCUT_CONTRACT as shortcut } from '@/reading/shortcut';

type Scope = AuthPrincipal['scope'];
interface ApiRoutePolicy {
	readonly scopes: readonly Scope[];
	readonly coordinatesNotifications?: boolean;
}

const VAULT: readonly Scope[] = ['vault'];
const REMINDERS: readonly Scope[] = ['vault', 'reminders'];
const LIBRARY: readonly Scope[] = ['vault', 'reminders', 'reading'];
const ALL_SCOPES: readonly Scope[] = ['vault', 'reminders', 'reading', 'reading_capture'];

/** Worker-local admission, token scope and notification coordination policy.
 * Folder authority, feature state and encryption guards remain in the handlers.
 */
const routes: Readonly<Partial<Record<string, ApiRoutePolicy>>> = {
	'GET /encryption/pairing': { scopes: LIBRARY },
	'POST /encryption/pairing': { scopes: LIBRARY },
	'GET /encryption': { scopes: REMINDERS },
	'GET /encryption/capture-recovery': { scopes: VAULT },
	'GET /encryption/upload-receipt': { scopes: VAULT },
	'GET /encryption/deletion-precondition': { scopes: VAULT },
	'GET /encryption/folders': { scopes: VAULT },
	'GET /encryption/reset': { scopes: VAULT, coordinatesNotifications: true },
	'GET /encryption/conversion': { scopes: VAULT, coordinatesNotifications: true },
	'GET /encryption/conversion/file': { scopes: VAULT, coordinatesNotifications: true },
	'GET /encryption/conversion/settings': { scopes: VAULT, coordinatesNotifications: true },
	'GET /encryption/conversion/checkpoints': { scopes: VAULT, coordinatesNotifications: true },
	'POST /encryption/metadata': { scopes: VAULT },
	'POST /encryption/reset': { scopes: VAULT, coordinatesNotifications: true },
	'POST /encryption/conversion': { scopes: VAULT, coordinatesNotifications: true },
	'POST /encryption/conversion/finish': { scopes: VAULT, coordinatesNotifications: true },
	'PUT /encryption/conversion/file': { scopes: VAULT, coordinatesNotifications: true },
	'PUT /encryption/conversion/settings': { scopes: VAULT, coordinatesNotifications: true },
	'PUT /encryption/conversion/receipt': { scopes: VAULT, coordinatesNotifications: true },
	'PUT /encryption/conversion/checkpoint': { scopes: VAULT, coordinatesNotifications: true },
	'PUT /encryption/conversion/reading-capture': { scopes: VAULT, coordinatesNotifications: true },
	'GET /reminders/encrypted-files': { scopes: REMINDERS },
	'GET /reminders/encrypted-file': { scopes: REMINDERS },
	'GET /reminders/encrypted-receipt': { scopes: REMINDERS },
	'POST /reminders/encrypted-commit': { scopes: REMINDERS, coordinatesNotifications: true },
	'GET /reading/encryption': { scopes: LIBRARY },
	'GET /reading/encrypted-receipt': { scopes: LIBRARY },
	'GET /reading/encrypted-files': { scopes: LIBRARY },
	'GET /reading/encrypted-file': { scopes: LIBRARY },
	'POST /reading/encrypted-commit': { scopes: LIBRARY },
	'GET /health': { scopes: REMINDERS },
	'GET /diagnostics': { scopes: VAULT },
	'GET /settings': { scopes: VAULT },
	'PUT /settings': { scopes: VAULT, coordinatesNotifications: true },
	'GET /features': { scopes: LIBRARY },
	'POST /features': { scopes: VAULT },
	'GET /auth/tokens': { scopes: VAULT },
	'DELETE /auth/tokens': { scopes: VAULT, coordinatesNotifications: true },
	'DELETE /auth/session': { scopes: LIBRARY, coordinatesNotifications: true },
	'POST /links/title': { scopes: REMINDERS },
	'GET /sync/checkpoints': { scopes: VAULT },
	'GET /sync/checkpoint': { scopes: VAULT },
	'GET /sync/checkpoint-file': { scopes: VAULT },
	'GET /sync/check': { scopes: VAULT },
	'GET /sync/changes': { scopes: VAULT },
	'GET /sync/manifest': { scopes: VAULT },
	'GET /sync/download': { scopes: VAULT },
	'GET /sync/version-preview': { scopes: VAULT },
	'GET /sync/versions': { scopes: VAULT },
	'POST /sync/checkpoints': { scopes: VAULT, coordinatesNotifications: true },
	'POST /sync/import': { scopes: VAULT },
	'POST /sync/import/complete': { scopes: VAULT, coordinatesNotifications: true },
	'POST /sync/import/readiness': { scopes: VAULT },
	'POST /sync/import/prune': { scopes: VAULT, coordinatesNotifications: true },
	'POST /sync/import/upload': { scopes: VAULT },
	'POST /sync/metadata': { scopes: VAULT },
	'POST /sync/delete': { scopes: VAULT, coordinatesNotifications: true },
	'POST /sync/batch-upload': { scopes: VAULT },
	'POST /sync/batch-download': { scopes: VAULT },
	'POST /sync/batch-delete': { scopes: VAULT, coordinatesNotifications: true },
	'POST /sync/restore-version': { scopes: VAULT, coordinatesNotifications: true },
	'PUT /sync/upload': { scopes: VAULT },
	'PUT /sync/import/upload': { scopes: VAULT },
	'POST /notifications/retry': { scopes: VAULT, coordinatesNotifications: true },
	'POST /notifications/reminders-exchange': { scopes: VAULT },
	'POST /notifications/reminders-enrollment-token': { scopes: VAULT, coordinatesNotifications: true },
	'POST /notifications/subscribe': { scopes: REMINDERS, coordinatesNotifications: true },
	'POST /notifications/test': { scopes: VAULT },
	'POST /notifications/share/reading': { scopes: VAULT },
	'GET /notifications/vapid-public-key': { scopes: VAULT },
	'GET /notifications/subscriptions': { scopes: VAULT },
	'DELETE /notifications/subscribe': { scopes: REMINDERS, coordinatesNotifications: true },
	'GET /reminders/list': { scopes: REMINDERS },
	'DELETE /reminders/delete': { scopes: REMINDERS, coordinatesNotifications: true },
	'POST /reminders/create': { scopes: REMINDERS, coordinatesNotifications: true },
	'POST /reminders/update': { scopes: REMINDERS, coordinatesNotifications: true },
	'POST /reminders/set-completed': { scopes: REMINDERS, coordinatesNotifications: true },
	'POST /reminders/reorder': { scopes: REMINDERS, coordinatesNotifications: true },
	'GET /reminders/notification-policy': { scopes: VAULT },
	'POST /reminders/notification-policy': { scopes: VAULT, coordinatesNotifications: true },
	'PUT /reminders/notification-policy': { scopes: VAULT, coordinatesNotifications: true },
	'POST /reading/exchange': { scopes: VAULT },
	'POST /reading/handoff': { scopes: VAULT },
	'POST /reading/shortcut-pairing': { scopes: LIBRARY },
	'POST /reading/access': { scopes: VAULT },
	'POST /reading/prepare': { scopes: ALL_SCOPES },
	'POST /reading/capture': { scopes: ALL_SCOPES },
	'POST /reading/update': { scopes: LIBRARY },
	'POST /reading/retry': { scopes: LIBRARY },
	'POST /reading/fetching': { scopes: LIBRARY },
	'POST /reading/policy': { scopes: VAULT },
	'GET /reading/policy': { scopes: VAULT },
	'GET /reading/fetching': { scopes: LIBRARY },
	'GET /reading/session': { scopes: LIBRARY },
	'GET /reading/list': { scopes: LIBRARY },
	'GET /reading/item': { scopes: LIBRARY },
	[`POST ${shortcut.preparePath}`]: { scopes: ['reading_capture'] },
};

export function apiRoutePolicy(path: string, method: string): ApiRoutePolicy | undefined {
	const key = `${method} ${path}`;
	if (Object.hasOwn(routes, key)) return routes[key];
	// Older and newer transports must reach compatibility handling, including
	// the public one-use exchange, rather than failing admission with a 404.
	if (method === 'POST' && /^\/reading\/shortcut\/v(?:0|[1-9]\d{0,2})\/(prepare|exchange)$/.test(path)) return { scopes: VAULT };
	return undefined;
}
