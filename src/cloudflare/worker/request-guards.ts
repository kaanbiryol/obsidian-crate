import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER, isCrateMutation } from '../../protocol';
import { ENCRYPTION_PROTOCOL, type EncryptionServerState } from '../../encryption/server-state';
import { corsResponse } from './cors';
import { EncryptionStateError } from './encryption-state';
import { shortcutCompatibility, type ShortcutTransport } from './reading/shortcut-transport';

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

/** Uses freshly authenticated state before any forwarding or route dispatch. */
export function assertRequestEncryption(request: Request, encryption: EncryptionServerState | null): void {
	const path = new URL(request.url).pathname;
	const method = request.method;
	if (encryption?.mode === 'resetting' && !['/encryption/reset', '/encryption', '/health'].includes(path)) {
		throw new EncryptionStateError('Encryption reset is in progress. Resume it on the device that started it.', 423);
	}
	// Feature visibility is authenticated public policy, not private vault content.
	if (encryption && !(['/features', '/reading/encryption', '/reading/session'].includes(path) && method === 'GET') && path !== '/health' && !path.startsWith('/encryption') && !path.startsWith('/auth/')) {
		const protocol = Number(request.headers.get(CRATE_PROTOCOL_HEADER));
		if (!Number.isInteger(protocol) || protocol < ENCRYPTION_PROTOCOL || protocol > CRATE_PLUGIN_PROTOCOL.current) {
			throw new EncryptionStateError('Update Crate before accessing this encrypted vault', 428);
		}
		if (request.headers.get('X-Crate-Encryption-Vault') !== encryption.vaultId
			|| request.headers.get('X-Crate-Encryption-Generation') !== String(encryption.generation)) {
			throw new EncryptionStateError('Unlock this vault with its current encryption keys before syncing', 428);
		}
		if (encryption.mode !== 'active') throw new EncryptionStateError('Encryption conversion is in progress. Resume it before syncing.', 423);
		if (path === '/links/title' || (path.startsWith('/reminders/') && path !== '/reminders/notification-policy' && !path.startsWith('/reminders/encrypted')) || path.startsWith('/sync/import')) {
			throw new EncryptionStateError('This operation requires the encrypted client workflow', 428);
		}
	}
}
