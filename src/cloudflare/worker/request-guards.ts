import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER, isCrateMutation } from '../../protocol/server-info';
import { ENCRYPTION_VAULT_HEADER, type EncryptionServerState } from '../../encryption/server-state';
import { corsResponse } from './http/cors';
import { EncryptionStateError, hasEncryptionAuthority } from './encryption/state';
import { shortcutCompatibility, shortcutTransport, type ShortcutTransport } from './reading/shortcut-transport';
import { ENCRYPTION_RESET_PATHS, KEYLESS_ENCRYPTED_READ_PATHS, PLAINTEXT_ONLY_PATHS } from './routes/policy';

function hasCompatibleProtocol(request: Request): boolean {
	const protocol = Number(request.headers.get(CRATE_PROTOCOL_HEADER));
	return Number.isInteger(protocol) && protocol >= CRATE_PLUGIN_PROTOCOL.oldestCompatible && protocol <= CRATE_PLUGIN_PROTOCOL.current;
}

/** Runs after admission, before public grants or authenticated route handling. */
export function checkRequestProtocol(request: Request, shortcut: ShortcutTransport | null): Response | null {
	const path = new URL(request.url).pathname;
	const method = request.method;
	const compatibility = shortcut && shortcutCompatibility(shortcut);
	if (compatibility) return corsResponse({ error: compatibility.message, code: compatibility.code }, compatibility.status);
	if (isCrateMutation(path, method) && path !== '/notifications/share/reading' && !shortcut && !hasCompatibleProtocol(request)) {
		return corsResponse({ error: 'Update Crate and reload the web app before making changes.', code: 'protocol_incompatible', protocol: CRATE_PLUGIN_PROTOCOL }, 428);
	}
	return null;
}

/** Uses freshly authenticated state before any forwarding or route dispatch. */
export function assertRequestEncryption(request: Request, encryption: EncryptionServerState | null): void {
	const path = new URL(request.url).pathname;
	const method = request.method;
	const managesAccess = path === '/health' || path.startsWith('/encryption') || path.startsWith('/auth/');
	// Keys kept after encryption was turned off would store ciphertext with random names
	// that plaintext devices then download.
	if (!encryption && request.headers.has(ENCRYPTION_VAULT_HEADER) && !managesAccess) {
		throw new EncryptionStateError('Encryption is off on this server. Open Manage encryption on this device to choose how to sync.', 428);
	}
	if (encryption?.mode === 'resetting' && !ENCRYPTION_RESET_PATHS.includes(path)) {
		throw new EncryptionStateError('Encryption reset is in progress. Resume it on the device that started it.', 423);
	}
	// The native shortcut holds no keys; the server seals its note to the vault.
	if (encryption && shortcutTransport(request)?.kind === 'prepare') {
		if (encryption.mode !== 'active') throw new EncryptionStateError('An encryption reset is in progress. Resume it on the device that started it.', 423);
		return;
	}
	if (encryption && !(KEYLESS_ENCRYPTED_READ_PATHS.includes(path) && method === 'GET') && !managesAccess) {
		if (!hasCompatibleProtocol(request)) throw new EncryptionStateError('Update Crate before accessing this encrypted vault', 428);
		if (!hasEncryptionAuthority(request, encryption)) {
			throw new EncryptionStateError('Unlock this vault with its current encryption keys before syncing', 428);
		}
		if (encryption.mode !== 'active') throw new EncryptionStateError('An encryption reset is in progress. Resume it on the device that started it.', 423);
		// Reading rejects its own plaintext routes, including grant redemption, which skips this guard.
		if (PLAINTEXT_ONLY_PATHS.includes(path) && !path.startsWith('/reading/')) {
			throw new EncryptionStateError('This operation requires the encrypted client workflow', 428);
		}
	}
}
