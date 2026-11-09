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
	/** Requests per actor per minute, charged only after the actor is verified. */
	readonly rateLimit?: number;
	/** Still served, for any method on this path, while an encryption reset runs. */
	readonly duringEncryptionReset?: true;
	/** A GET an encrypted vault serves without its keys: public feature state, not vault content. */
	readonly keylessEncryptedRead?: true;
	/** Rejected, for any method on this path, in an encrypted vault: encrypted clients use other routes. */
	readonly plaintextOnly?: true;
	/** Answered before authentication by `routes/public.ts`, so no token scope applies. */
	readonly public?: true;
}

const COORDINATOR = { kind: 'coordinator', wake: true } as const;
/** Serialized with mutations but creating no notification or Reading work (token and
 * subscription changes, checkpoints), so it neither arms a processing pass nor resets
 * the retry budget of a running one. Delivery checks recipients when it sends. */
const COORDINATOR_READ = { kind: 'coordinator', wake: false } as const;
const READING_GRANT = { kind: 'reading-grant' } as const;

const VAULT: readonly Scope[] = ['vault'];
const REMINDERS: readonly Scope[] = ['vault', 'reminders'];
const LIBRARY: readonly Scope[] = ['vault', 'reminders'];
const ALL_SCOPES: readonly Scope[] = ['vault', 'reminders', 'reading_capture'];
const PUBLIC = { scopes: [], public: true } as const;

/** Worker-local admission, token scope and execution policy. Dispatch, folder
 * authority, feature state and encryption guards are not declared here.
 */
const routes: Readonly<Partial<Record<string, ApiRoutePolicy>>> = {
	'GET /encryption/pairing': { scopes: LIBRARY },
	'POST /encryption/pairing': { scopes: LIBRARY },
	'GET /encryption': { scopes: REMINDERS, duringEncryptionReset: true },
	'GET /encryption/deletion-precondition': { scopes: VAULT },
	// Authenticated under the lock, a resume waits for a begin request still in flight instead
	// of reading 401 for its replacement credential and resending the destructive begin.
	'GET /encryption/reset': { scopes: VAULT, execution: COORDINATOR_READ, duringEncryptionReset: true },
	'POST /encryption/metadata': { scopes: VAULT },
	'POST /encryption/reset': { scopes: VAULT, execution: COORDINATOR, duringEncryptionReset: true },
	'GET /reminders/encrypted-files': { scopes: REMINDERS },
	'GET /reminders/encrypted-file': { scopes: REMINDERS },
	'POST /reminders/encrypted-commit': { scopes: REMINDERS, execution: COORDINATOR },
	'GET /reading/encryption': { scopes: LIBRARY, keylessEncryptedRead: true },
	'GET /reading/encrypted-files': { scopes: LIBRARY },
	'GET /reading/encrypted-file': { scopes: LIBRARY },
	'POST /reading/encrypted-commit': { scopes: LIBRARY, execution: COORDINATOR },
	// Outside the coordinator: a slow page download must not hold the write lock.
	'POST /reading/encrypted-extract': { scopes: LIBRARY, rateLimit: 30 },
	'GET /health': { scopes: REMINDERS, duringEncryptionReset: true },
	'GET /diagnostics': { scopes: VAULT },
	'GET /settings': { scopes: VAULT },
	'PUT /settings': { scopes: VAULT, execution: COORDINATOR_READ },
	'GET /features': { scopes: LIBRARY, keylessEncryptedRead: true },
	'POST /features': { scopes: VAULT, execution: COORDINATOR, rateLimit: 10 },
	'GET /auth/tokens': { scopes: VAULT },
	'DELETE /auth/tokens': { scopes: VAULT, execution: COORDINATOR_READ },
	'DELETE /auth/session': { scopes: LIBRARY, execution: COORDINATOR_READ },
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
	'POST /sync/checkpoints': { scopes: VAULT, execution: COORDINATOR_READ },
	'POST /sync/import': { scopes: VAULT, plaintextOnly: true },
	'POST /sync/import/complete': { scopes: VAULT, execution: COORDINATOR, plaintextOnly: true },
	'POST /sync/import/readiness': { scopes: VAULT, plaintextOnly: true },
	'POST /sync/import/prune': { scopes: VAULT, execution: COORDINATOR, plaintextOnly: true },
	'POST /sync/import/upload': { scopes: VAULT, plaintextOnly: true },
	'POST /sync/metadata': { scopes: VAULT },
	'POST /sync/batch-upload': { scopes: VAULT, execution: { kind: 'transfer', path: TRANSFER_PATHS.syncBatchUpload } },
	'POST /sync/batch-download': { scopes: VAULT },
	'POST /sync/batch-delete': { scopes: VAULT, execution: COORDINATOR },
	'POST /sync/restore-version': { scopes: VAULT, execution: COORDINATOR },
	'PUT /sync/upload': { scopes: VAULT, execution: { kind: 'transfer', path: TRANSFER_PATHS.syncUpload } },
	'PUT /sync/import/upload': { scopes: VAULT, plaintextOnly: true },
	'POST /notifications/reminders-exchange': { ...PUBLIC, rateLimit: 10 },
	'POST /auth/device-pairing': { ...PUBLIC, rateLimit: 10 },
	'POST /notifications/reminders-enrollment-token': { scopes: VAULT, execution: COORDINATOR_READ, rateLimit: 10 },
	'POST /notifications/subscribe': { scopes: REMINDERS, execution: COORDINATOR_READ, rateLimit: 30 },
	'POST /notifications/test': { scopes: VAULT, rateLimit: 3 },
	'POST /notifications/share/reading': { ...PUBLIC, rateLimit: 30 },
	'GET /notifications/vapid-public-key': { ...PUBLIC },
	'GET /notifications/subscriptions': { scopes: VAULT },
	'DELETE /notifications/subscribe': { scopes: REMINDERS, execution: COORDINATOR_READ, rateLimit: 30 },
	'GET /reminders/list': { scopes: REMINDERS, initializeProjection: true, plaintextOnly: true },
	'DELETE /reminders/delete': { scopes: REMINDERS, execution: COORDINATOR, plaintextOnly: true },
	'POST /reminders/create': { scopes: REMINDERS, execution: COORDINATOR, plaintextOnly: true },
	'POST /reminders/update': { scopes: REMINDERS, execution: COORDINATOR, plaintextOnly: true },
	'POST /reminders/set-completed': { scopes: REMINDERS, execution: COORDINATOR, plaintextOnly: true },
	'POST /reminders/reorder': { scopes: REMINDERS, execution: COORDINATOR, plaintextOnly: true },
	'GET /reminders/notification-policy': { scopes: VAULT },
	'POST /reminders/notification-policy': { scopes: VAULT, execution: COORDINATOR },
	'PUT /reminders/notification-policy': { scopes: VAULT, execution: COORDINATOR },
	'POST /reading/handoff': { scopes: VAULT, execution: READING_GRANT, rateLimit: 30, plaintextOnly: true },
	'POST /reading/shortcut-pairing': { scopes: LIBRARY, execution: COORDINATOR_READ, rateLimit: 5 },
	'POST /reading/capture': { scopes: ALL_SCOPES, execution: COORDINATOR, rateLimit: 30, plaintextOnly: true },
	'POST /reading/update': { scopes: LIBRARY, execution: COORDINATOR, rateLimit: 60, plaintextOnly: true },
	'POST /reading/retry': { scopes: LIBRARY, execution: COORDINATOR, rateLimit: 10, plaintextOnly: true },
	'POST /reading/delete': { scopes: LIBRARY, execution: COORDINATOR, rateLimit: 30, plaintextOnly: true },
	'POST /reading/policy': { scopes: VAULT, execution: COORDINATOR, rateLimit: 10 },
	'GET /reading/policy': { scopes: VAULT },
	// The card index: Obsidian publishes it, both web apps read it, in either vault mode.
	'GET /reading/index': { scopes: LIBRARY },
	'PUT /reading/index': { scopes: VAULT, rateLimit: 30 },
	'GET /reading/index/shard': { scopes: LIBRARY },
	// A first publish uploads every shard.
	'PUT /reading/index/shard': { scopes: VAULT, rateLimit: 160 },
	'GET /reading/index/changes': { scopes: LIBRARY },
	'GET /reading/index/file': { scopes: LIBRARY },
	'GET /reading/session': { scopes: LIBRARY, keylessEncryptedRead: true },
	// Plaintext list and item reads authenticate here and answer a complete index from one D1
	// snapshot. An index rebuild, which writes, and full list pages run under the coordinator
	// lock (see `reading/library-read.ts`); they wake notification processing only when a rebuild ran.
	'GET /reading/list': { scopes: LIBRARY, plaintextOnly: true },
	'GET /reading/item': { scopes: LIBRARY, plaintextOnly: true },
	[`POST ${shortcut.preparePath}`]: { scopes: ['reading_capture'], execution: COORDINATOR, rateLimit: 30 },
	[`POST ${shortcut.exchangePath}`]: { scopes: VAULT, execution: READING_GRANT, rateLimit: 10 },
};

const flaggedPaths = (flag: (policy: ApiRoutePolicy) => unknown): readonly string[] =>
	[...new Set(Object.entries(routes).flatMap(([key, policy]) => policy && flag(policy) ? [key.split(' ')[1]!] : []))];
export const ENCRYPTION_RESET_PATHS = flaggedPaths(policy => policy.duringEncryptionReset);
export const KEYLESS_ENCRYPTED_READ_PATHS = flaggedPaths(policy => policy.keylessEncryptedRead);
export const PLAINTEXT_ONLY_PATHS = flaggedPaths(policy => policy.plaintextOnly);
export const rateLimitedActions: ReadonlyMap<string, number> = new Map(Object.entries(routes)
	.flatMap(([key, policy]) => policy?.rateLimit ? [[key, policy.rateLimit] as const] : []));

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
