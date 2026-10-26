import { handleEncryptionPairing } from '../encryption/pairing';
import { readEncryptionState } from '../encryption/state';
import { handleDeletionPrecondition } from '../encryption/receipts';
import { handleEncryptionMetadata } from '../encryption/metadata';
import { readFolderLabel } from '../encryption/folder-labels';
import { corsResponse } from '../cors';
import type { AuthPrincipal } from '../auth/index';
import type { EncryptionServerState } from '../../../encryption/server-state';

/** Every session receives the public configuration and the encrypted recovery
 * bundle. The recovery key never leaves the client; API permissions remain scoped. */
export async function handleEncryptionRoute(request: Request, db: D1Database, path: string, principal: AuthPrincipal, authenticatedState?: EncryptionServerState | null): Promise<Response | null> {
	if (path === '/encryption/pairing') return handleEncryptionPairing(request, db, principal, authenticatedState === undefined ? await readEncryptionState(db) : authenticatedState);
	if (path === '/encryption/deletion-precondition' && request.method === 'GET' && principal.scope === 'vault') return handleDeletionPrecondition(request, db);
	if (path === '/encryption' && request.method === 'GET') {
		// Authentication already read and validated this public configuration.
		const state = authenticatedState === undefined ? await readEncryptionState(db) : authenticatedState;
		const folderLabel = state && principal.scope === 'reminders' ? await readFolderLabel(db, principal.folderPath) : null;
		return corsResponse({ encryption: state, ...(folderLabel ? { folderPath: principal.folderPath, folderLabel } : {}) }, 200, { 'Cache-Control': 'no-store' });
	}
	if (path !== '/encryption/metadata' || request.method !== 'POST' || principal.scope !== 'vault') return null;
	return handleEncryptionMetadata(request, db);
}
