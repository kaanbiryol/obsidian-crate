import type { AuthPrincipal } from '../auth/authenticate';
import { READING_SHORTCUT_CONTRACT as shortcut } from '@/reading/shortcut';
import { TRANSFER_PATHS } from '../coordinator/coordinator';

type Scope = AuthPrincipal['scope'];
interface ApiRoutePolicy {
	readonly scopes: readonly Scope[];
	readonly execution?:
		| { readonly kind: 'coordinator'; readonly wake: boolean }
		| { readonly kind: 'reading-grant' }
		| { readonly kind: 'transfer'; readonly path: typeof TRANSFER_PATHS.syncUpload | typeof TRANSFER_PATHS.syncBatchUpload };
	readonly initializeProjection?: boolean;
}

const COORDINATOR = { kind: 'coordinator', wake: true } as const;
/** Serialized with mutations but creating no notification or Reading work, so it
 * neither arms a processing pass nor resets the retry budget of a running one. */
const COORDINATOR_READ = { kind: 'coordinator', wake: false } as const;
const READING_GRANT = { kind: 'reading-grant' } as const;

const VAULT: readonly Scope[] = ['vault'];
const REMINDERS: readonly Scope[] = ['vault', 'reminders'];
const LIBRARY: readonly Scope[] = ['vault', 'reminders', 'reading'];
const ALL_SCOPES: readonly Scope[] = ['vault', 'reminders', 'reading', 'reading_capture'];

/** Worker-local admission, token scope and execution policy. Dispatch, folder
 * authority, feature state and encryption guards are not declared here.
 */
const routes: Readonly<Partial<Record<string, ApiRoutePolicy>>> = {
	'GET /encryption/pairing': { scopes: LIBRARY },
	'POST /encryption/pairing': { scopes: LIBRARY },
	'GET /encryption': { scopes: REMINDERS },
	'GET /encryption/deletion-precondition': { scopes: VAULT },
	'GET /encryption/reset': { scopes: VAULT, execution: COORDINATOR_READ },
	'POST /encryption/metadata': { scopes: VAULT },
	'POST /encryption/reset': { scopes: VAULT, execution: COORDINATOR },
	'GET /reminders/encrypted-files': { scopes: REMINDERS },
	'GET /reminders/encrypted-file': { scopes: REMINDERS },
	'POST /reminders/encrypted-commit': { scopes: REMINDERS, execution: COORDINATOR },
	'GET /reading/encryption': { scopes: LIBRARY },
	'GET /reading/encrypted-files': { scopes: LIBRARY },
	'GET /reading/encrypted-file': { scopes: LIBRARY },
	'POST /reading/encrypted-commit': { scopes: LIBRARY, execution: COORDINATOR },
	// Outside the coordinator: a slow page download must not hold the write lock.
	'POST /reading/encrypted-extract': { scopes: LIBRARY },
	'GET /health': { scopes: REMINDERS },
	'GET /diagnostics': { scopes: VAULT },
	'GET /settings': { scopes: VAULT },
	'PUT /settings': { scopes: VAULT, execution: COORDINATOR_READ },
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
	'POST /sync/batch-upload': { scopes: VAULT, execution: { kind: 'transfer', path: TRANSFER_PATHS.syncBatchUpload } },
	'POST /sync/batch-download': { scopes: VAULT },
	'POST /sync/batch-delete': { scopes: VAULT, execution: COORDINATOR },
	'POST /sync/restore-version': { scopes: VAULT, execution: COORDINATOR },
	'PUT /sync/upload': { scopes: VAULT, execution: { kind: 'transfer', path: TRANSFER_PATHS.syncUpload } },
	'PUT /sync/import/upload': { scopes: VAULT },
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
	'POST /reading/handoff': { scopes: VAULT, execution: READING_GRANT },
	'POST /reading/shortcut-pairing': { scopes: LIBRARY, execution: COORDINATOR },
	'POST /reading/capture': { scopes: ALL_SCOPES, execution: COORDINATOR },
	'POST /reading/update': { scopes: LIBRARY, execution: COORDINATOR },
	'POST /reading/retry': { scopes: LIBRARY, execution: COORDINATOR },
	'POST /reading/policy': { scopes: VAULT, execution: COORDINATOR },
	'GET /reading/policy': { scopes: VAULT, execution: COORDINATOR_READ },
	'GET /reading/session': { scopes: LIBRARY, execution: COORDINATOR_READ },
	// Plaintext list and item reads project the folder under the lock and can queue extractions.
	'GET /reading/list': { scopes: LIBRARY, execution: COORDINATOR },
	'GET /reading/item': { scopes: LIBRARY, execution: COORDINATOR },
	[`POST ${shortcut.preparePath}`]: { scopes: ['reading_capture'], execution: COORDINATOR },
	[`POST ${shortcut.exchangePath}`]: { scopes: VAULT, execution: READING_GRANT },
};

/** Every declared route, so tests can check the other route tables against this one. */
export function apiRoutes(): Array<{ method: string; path: string }> {
	return Object.keys(routes).map(key => {
		const [method = '', path = ''] = key.split(' ');
		return { method, path };
	});
}

export function apiRoutePolicy(path: string, method: string): ApiRoutePolicy | undefined {
	const key = `${method} ${path}`;
	return Object.hasOwn(routes, key) ? routes[key] : undefined;
}
