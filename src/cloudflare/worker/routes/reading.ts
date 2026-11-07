import { readEncryptionState } from '../encryption/state';
import { handleEncryptedFolderFiles } from '../encryption/encrypted-folder-files';
import { issueShortcutPairing, exchangeShortcutPairing } from '../reading/shortcut-pairing';
import { shortcutTransport, validateShortcutBody } from '../reading/shortcut-transport';
import { armNotificationCoordinator } from '../notifications/lifecycle';
import { chargeRouteAction } from '../admission/rate-limit';
import type { Env } from '../types';
import type { AuthPrincipal } from '../auth/authenticate';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { parseJsonObject } from '../http/request-validation';
import { policy, authority, readingResponse, ReadingError } from '../reading/common';
import { prepareHandoff, updatePolicy, handoffAuthority, labelledPolicy } from '../reading/access';
import { readFolderLabel } from '../encryption/folder-labels';
import { mutateReading } from '../reading/mutations';
import { extractForEncryptedReading } from '../reading/encrypted-extract';
import { isLibraryRead, loadLibraryRead, readLibrary } from '../reading/library-read';

/** Dispatches `/reading/` routes. Each charges its own action budget once its authority
 * is known. `forward` runs the request under the coordinator lock; see `readLibrary`. */
export async function handleReadingRoute(request: Request, env: Env, principal?: AuthPrincipal, state?: DurableObjectState, authenticatedEncryption?: EncryptionServerState | null, featurePolicyValue?: string | null,
	forward?: () => Promise<Response>): Promise<Response> {
	const url = new URL(request.url), path = url.pathname;
	// Authentication loads the encryption state with the token.
	const encryption = authenticatedEncryption !== undefined ? authenticatedEncryption : await readEncryptionState(env.DB);
	const shortcut = shortcutTransport(request);
	if (path.startsWith('/reading/encrypted-')) {
		if (!principal || principal.scope === 'reading_capture') throw new ReadingError('Library access is required.', 403);
		const current = await authority(env.DB, principal, featurePolicyValue);
		const limited = await chargeRouteAction(request, env.DB, principal.tokenId); if (limited) return limited;
		if (path === '/reading/encrypted-extract' && request.method === 'POST') {
			if (!encryption) throw new ReadingError('Article downloads here are only for encrypted Reading folders.', 409);
			// As in unencrypted vaults, the web app then saves the link as a bookmark.
			if (!current.enabled) throw new ReadingError('Allow article fetching in Reading settings before downloading articles.', 403, 'reading_fetching_off');
			return await extractForEncryptedReading(request, env);
		}
		return await handleEncryptedFolderFiles(request, env, path, 'reading', current.folder_path, encryption) ?? readingResponse({ error: 'Not found' }, 404);
	}
	if (encryption && (shortcut?.kind === 'prepare' || ['/reading/handoff', '/reading/capture', '/reading/update', '/reading/retry', '/reading/delete', '/reading/list', '/reading/item'].includes(path))) throw new ReadingError('Use an unlocked, updated Reading app for this encrypted vault.', 428);
	if (path === '/reading/encryption' && request.method === 'GET' && principal) {
		const current = await authority(env.DB, principal, featurePolicyValue); // Reading access only.
		// The web app recovers the plaintext folder name from this label with the vault key.
		return readingResponse({ encryption, ...(encryption ? { folderLabel: await readFolderLabel(env.DB, current.folder_path) } : {}) });
	}
	const parsed = request.method === 'GET' ? { ok: true as const, value: {} } : await parseJsonObject(request, path === '/reading/update' || path === '/reading/delete' ? 262_144 : 24_576);
	if (!parsed.ok) return parsed.response;
	const body = parsed.value;
	if (shortcut) validateShortcutBody(body, shortcut.kind);
	if (shortcut?.kind === 'exchange') return await exchangeShortcutPairing(env.DB, body, request);
	if (path === '/reading/handoff' && request.method === 'POST') {
		const handoff = await handoffAuthority(env.DB, request);
		const limited = await chargeRouteAction(request, env.DB, handoff.principal.tokenId); if (limited) return limited;
		if (state) await armNotificationCoordinator(state);
		return await mutateReading(env, handoff.principal, handoff.current, handoff.body, 'capture');
	}
	if (!principal) throw new ReadingError('Reading access is required.', 401);
	const limited = await chargeRouteAction(request, env.DB, principal.tokenId); if (limited) return limited;
	if (path === '/reading/policy') {
		if (principal.scope !== 'vault') throw new ReadingError('Open Crate settings in Obsidian to change Reading setup.', 403);
		if (request.method === 'GET') return readingResponse({ policy: await labelledPolicy(env.DB, await policy(env.DB)) });
		if (request.method === 'POST') return await updatePolicy(env.DB, body);
	}
	const loaded = isLibraryRead(request, path) ? await loadLibraryRead(env.DB, url) : undefined;
	const current = await authority(env.DB, principal, featurePolicyValue, loaded?.policy);
	if (path === '/reading/shortcut-pairing' && request.method === 'POST') return await issueShortcutPairing(env.DB, principal, current, url.origin);
	if (shortcut?.kind === 'prepare' && request.method === 'POST') return await prepareHandoff(env.DB, principal, body, url.origin);
	if (path === '/reading/capture' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'capture');
	if (principal.scope === 'reading_capture') throw new ReadingError('This credential can only save links.', 403);
	if (path === '/reading/session' && request.method === 'GET') return readingResponse({ id: principal.tokenId, folderPath: current.folder_path, generation: current.generation, expiresAt: principal.expiresAt ?? null, day: Math.floor(Date.now() / 86400_000) });
	if (path === '/reading/update' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'update');
	if (path === '/reading/retry' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'retry');
	if (path === '/reading/delete' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'delete');
	if (loaded) return await readLibrary(request, env, current, loaded, state, forward);
	return readingResponse({ error: 'Not found' }, 404);
}
