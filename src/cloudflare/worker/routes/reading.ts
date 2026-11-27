import { readEncryptionState } from '../encryption/state';
import { handleEncryptedFolderFiles } from '../encryption/encrypted-folder-files';
import { issueShortcutPairing, exchangeShortcutPairing } from '../reading/shortcut-pairing';
import { shortcutTransport, validateShortcutBody } from '../reading/shortcut-transport';
import { armNotificationCoordinator } from '../notifications/lifecycle';
import { chargeRouteAction } from '../admission/rate-limit';
import type { Env } from '../types';
import type { AuthPrincipal } from '../auth/authenticate';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { parseJsonObject, READING_EDIT_JSON_BODY_BYTES, SMALL_JSON_BODY_BYTES } from '../http/request-validation';
import { policy, policyStatement, authority, readingResponse, ReadingError } from '../reading/common';
import { prepareHandoff, updatePolicy, handoffAuthority, labelledPolicy } from '../reading/access';
import { readFolderLabel } from '../encryption/folder-labels';
import { loadReadingMutation, mutateReading } from '../reading/mutations';

/** The library mutations and the action each one performs. */
const MUTATION_ACTIONS: Partial<Record<string, string>> = { '/reading/capture': 'capture', '/reading/update': 'update', '/reading/retry': 'retry', '/reading/delete': 'delete' };
import { forwardEncryptedExtract } from '../reading/encrypted-extract';
import { isLibraryRead, loadLibraryRead, readLibrary } from '../reading/library-read';
import { PLAINTEXT_ONLY_PATHS } from './policy';
import { takenReadingPaths } from '../reading/taken-names';
import { readReadingImage } from '../reading/image-file';
import { featurePolicy, parseStoredFeaturePolicy } from '../server/feature-policy';

export interface ReadingRouteOptions {
	/** The coordinator's state, when the request runs under its lock. */
	state?: DurableObjectState;
	/** The encryption state authentication loaded with the token; read when omitted. */
	encryption?: EncryptionServerState | null;
	/** The stored feature policy authentication loaded with the token. */
	featurePolicy?: string | null;
	/** Runs the request under the coordinator lock; see `readLibrary`. */
	forward?: () => Promise<Response>;
}

/** Dispatches `/reading/` routes. Three kinds of caller reach them, each charged once
 * its authority is known: a library session for the encrypted routes, a one-use grant
 * (a Shortcut exchange or a handoff) that names its own authority, and a bearer for the
 * rest. Grant redemption runs before authentication, so the shared encryption guards
 * never see it and the plaintext checks stay here. */
export async function handleReadingRoute(request: Request, env: Env, principal?: AuthPrincipal, { state, encryption: authenticatedEncryption, featurePolicy: featurePolicyValue, forward }: ReadingRouteOptions = {}): Promise<Response> {
	const url = new URL(request.url), path = url.pathname;
	// Authentication loads the encryption state with the token.
	const encryption = authenticatedEncryption !== undefined ? authenticatedEncryption : await readEncryptionState(env.DB);
	const shortcut = shortcutTransport(request);
	if (path.startsWith('/reading/encrypted-')) return await handleEncryptedLibraryRoute(request, env, path, principal, featurePolicyValue, encryption);
	// Save to Crate cannot hash search terms or encrypt, so encrypted vaults do not offer it.
	if (encryption && (shortcut || path === '/reading/shortcut-pairing')) throw new ReadingError('Save to Crate is not available in encrypted vaults. Save links in the Crate app or Obsidian.', 409, 'shortcut_encrypted_vault');
	if (encryption && PLAINTEXT_ONLY_PATHS.includes(path)) throw new ReadingError('Use an unlocked, updated Reading app for this encrypted vault.', 428);
	if (path === '/reading/encryption' && request.method === 'GET' && principal) {
		const current = await authority(env.DB, principal, featurePolicyValue); // Reading access only.
		// The web app recovers the plaintext folder name from this label with the vault key.
		return readingResponse({ encryption, ...(encryption ? { folderLabel: await readFolderLabel(env.DB, current.folder_path) } : {}) });
	}
	const parsed = request.method === 'GET' ? { ok: true as const, value: {} } : await parseJsonObject(request, path === '/reading/update' || path === '/reading/delete' ? READING_EDIT_JSON_BODY_BYTES : SMALL_JSON_BODY_BYTES);
	if (!parsed.ok) return parsed.response;
	const body = parsed.value;
	if (shortcut) validateShortcutBody(body, shortcut.kind);
	// One-use grants: the code or handoff, not a bearer, names the authority.
	if (shortcut?.kind === 'exchange') return await exchangeShortcutPairing(env.DB, body, request);
	if (path === '/reading/handoff' && request.method === 'POST') {
		const handoff = await handoffAuthority(env.DB, request);
		const limited = await chargeRouteAction(request, env.DB, handoff.principal.tokenId); if (limited) return limited;
		if (state) await armNotificationCoordinator(state);
		return await mutateReading(env, handoff.principal, handoff.current, handoff.body, 'capture');
	}
	if (!principal) throw new ReadingError('Reading access is required.', 401);
	const limited = await chargeRouteAction(request, env.DB, principal.tokenId); if (limited) return limited;
	return await handleBearerReadingRoute(request, env, url, principal, body, { state, encryption, featurePolicy: featurePolicyValue, forward }, shortcut);
}

/** Encrypted library files and article downloads, for library sessions only. */
async function handleEncryptedLibraryRoute(request: Request, env: Env, path: string, principal: AuthPrincipal | undefined, featurePolicyValue: string | null | undefined, encryption: EncryptionServerState | null): Promise<Response> {
	if (!principal || principal.scope === 'reading_capture') throw new ReadingError('Library access is required.', 403);
	const current = await authority(env.DB, principal, featurePolicyValue);
	const limited = await chargeRouteAction(request, env.DB, principal.tokenId); if (limited) return limited;
	if (path === '/reading/encrypted-extract' && request.method === 'POST') {
		if (!encryption) throw new ReadingError('Article downloads here are only for encrypted Reading folders.', 409);
		// As in unencrypted vaults, the web app then saves the link as a bookmark.
		if (!current.enabled) throw new ReadingError('Allow article fetching in Reading settings before downloading articles.', 403, 'reading_fetching_off');
		const images = (featurePolicyValue === undefined ? await featurePolicy(env.DB) : parseStoredFeaturePolicy(featurePolicyValue)).readingImages !== 'remote';
		return await forwardEncryptedExtract(request, env, images);
	}
	return await handleEncryptedFolderFiles(request, env, path, 'reading', current.folder_path, encryption) ?? readingResponse({ error: 'Not found' }, 404);
}

/** Routes a charged bearer reaches: setup, capture, the library and its session. */
async function handleBearerReadingRoute(request: Request, env: Env, url: URL, principal: AuthPrincipal, body: Record<string, unknown>,
	{ state, encryption, featurePolicy: featurePolicyValue, forward }: ReadingRouteOptions & { encryption: EncryptionServerState | null },
	shortcut: ReturnType<typeof shortcutTransport>): Promise<Response> {
	const path = url.pathname;
	if (path === '/reading/policy') {
		if (principal.scope !== 'vault') throw new ReadingError('Open Crate settings in Obsidian to change Reading setup.', 403);
		if (request.method === 'GET') return readingResponse({ policy: await labelledPolicy(env.DB, await policy(env.DB), encryption) });
		if (request.method === 'POST') return await updatePolicy(env.DB, body);
	}
	const loaded = isLibraryRead(request, path) ? await loadLibraryRead(env.DB, url) : undefined;
	const action = request.method === 'POST' ? MUTATION_ACTIONS[path] : undefined;
	// A mutation reads the policy, its receipt, the index row and its note in one round trip.
	const mutation = action ? await loadReadingMutation(env.DB, policyStatement(env.DB), body, action) : undefined;
	const current = await authority(env.DB, principal, featurePolicyValue, loaded ? loaded.policy : mutation?.policy);
	if (path === '/reading/shortcut-pairing' && request.method === 'POST') return await issueShortcutPairing(env.DB, principal, current, url.origin);
	if (shortcut?.kind === 'prepare' && request.method === 'POST') return await prepareHandoff(env.DB, principal, body, url.origin);
	if (path === '/reading/capture' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'capture', mutation?.mutation);
	if (principal.scope === 'reading_capture') throw new ReadingError('This credential can only save links.', 403);
	if (path === '/reading/session' && request.method === 'GET') return readingResponse({ id: principal.tokenId, folderPath: current.folder_path, generation: current.generation, expiresAt: principal.expiresAt ?? null, day: Math.floor(Date.now() / 86400_000) });
	if (path === '/reading/file' && request.method === 'GET') return await readReadingImage(env, current, url);
	if (action) return await mutateReading(env, principal, current, body, action, mutation?.mutation);
	if (loaded) return await readLibrary(request, env, current, loaded, state, forward, !!encryption);
	if (path === '/reading/taken' && request.method === 'GET') {
		if (!encryption) throw new ReadingError('Name checks are only for encrypted vaults.', 409);
		return await takenReadingPaths(env, current, url.searchParams);
	}
	return readingResponse({ error: 'Not found' }, 404);
}
