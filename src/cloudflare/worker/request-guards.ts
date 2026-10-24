import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER, isCrateMutation } from '../../protocol/server-info';
import type { EncryptionServerState } from '../../encryption/server-state';
import { corsResponse } from './cors';
import { EncryptionStateError, hasEncryptionAuthority } from './encryption/state';
import { shortcutCompatibility, shortcutTransport, type ShortcutTransport } from './reading/shortcut-transport';

/** Runs after admission, before public grants or authenticated route handling. */
export function checkRequestProtocol(request: Request, shortcut: ShortcutTransport | null): Response | null {
	const path = new URL(request.url).pathname;
	const method = request.method;
	const compatibility = shortcut && shortcutCompatibility(shortcut);
	if (compatibility) return corsResponse({ error: compatibility.message, code: compatibility.code }, compatibility.status);
	if (isCrateMutation(path, method) && path !== '/notifications/share/reading' && !shortcut) {
		const protocol = Number(request.headers.get(CRATE_PROTOCOL_HEADER));
		if (!Number.isInteger(protocol) || protocol < CRATE_PLUGIN_PROTOCOL.oldestCompatible || protocol > CRATE_PLUGIN_PROTOCOL.current) {
			return corsResponse({ error: 'Update Crate and reload the web app before making changes.', code: 'protocol_incompatible', protocol: CRATE_PLUGIN_PROTOCOL }, 428);
		}
	}
	return null;
}

/** Routes that remain available while an encryption reset is in progress. */
export const ENCRYPTION_RESET_PATHS: readonly string[] = ['/encryption/reset', '/encryption', '/health'];
/** Feature visibility is authenticated public policy, not private vault content. */
export const KEYLESS_ENCRYPTED_READ_PATHS: readonly string[] = ['/features', '/reading/encryption', '/reading/session'];

/** Uses freshly authenticated state before any forwarding or route dispatch. */
export function assertRequestEncryption(request: Request, encryption: EncryptionServerState | null): void {
	const path = new URL(request.url).pathname;
	const method = request.method;
	if (encryption?.mode === 'resetting' && !ENCRYPTION_RESET_PATHS.includes(path)) {
		throw new EncryptionStateError('Encryption reset is in progress. Resume it on the device that started it.', 423);
	}
	// The native shortcut holds no keys; the server seals its note to the vault.
	if (encryption && shortcutTransport(request)?.kind === 'prepare') {
		if (encryption.mode !== 'active') throw new EncryptionStateError('Encryption conversion is in progress. Resume it before syncing.', 423);
		return;
	}
	if (encryption && !(KEYLESS_ENCRYPTED_READ_PATHS.includes(path) && method === 'GET') && path !== '/health' && !path.startsWith('/encryption') && !path.startsWith('/auth/')) {
		const protocol = Number(request.headers.get(CRATE_PROTOCOL_HEADER));
		if (!Number.isInteger(protocol) || protocol < CRATE_PLUGIN_PROTOCOL.oldestCompatible || protocol > CRATE_PLUGIN_PROTOCOL.current) {
			throw new EncryptionStateError('Update Crate before accessing this encrypted vault', 428);
		}
		if (!hasEncryptionAuthority(request, encryption)) {
			throw new EncryptionStateError('Unlock this vault with its current encryption keys before syncing', 428);
		}
		if (encryption.mode !== 'active') throw new EncryptionStateError('Encryption conversion is in progress. Resume it before syncing.', 423);
		if (path === '/links/title' || (path.startsWith('/reminders/') && path !== '/reminders/notification-policy' && !path.startsWith('/reminders/encrypted')) || path.startsWith('/sync/import')) {
			throw new EncryptionStateError('This operation requires the encrypted client workflow', 428);
		}
	}
}
