import { handleEncryptionPairing } from '../encryption/pairing';
import { readEncryptionState, scopedEncryptionState } from '../encryption/state';
import { handleDeletionPrecondition, handleReminderReceipt, handleUploadReceipt } from '../encryption/receipts';
import { handleEncryptionFolders } from '../encryption/folders';
import { handleEncryptionMetadata } from '../encryption/metadata';
import { corsResponse } from '../cors';
import type { AuthPrincipal } from '../auth/index';
import type { EncryptionServerState } from '../../../encryption/server-state';

/** Scoped sessions receive their public scope and the encrypted recovery bundle.
 * The recovery key never leaves the client; API permissions remain scoped. */
export async function handleEncryptionRoute(request: Request, db: D1Database, path: string, principal: AuthPrincipal, authenticatedState?: EncryptionServerState | null): Promise<Response | null> {
  if (path === '/encryption/pairing') return handleEncryptionPairing(request, db, principal, authenticatedState === undefined ? await readEncryptionState(db) : authenticatedState);
	if (path === '/encryption/upload-receipt' && request.method === 'GET' && principal.scope === 'vault') return handleUploadReceipt(request, db);
	if (path === '/encryption/deletion-precondition' && request.method === 'GET' && principal.scope === 'vault') return handleDeletionPrecondition(request, db);
	if (path === '/encryption/folders' && request.method === 'GET' && principal.scope === 'vault') return handleEncryptionFolders(db);
	if (path === '/reminders/encrypted-receipt' && request.method === 'GET') return handleReminderReceipt(request, db);
	if (path === '/encryption' && request.method === 'GET') {
		// Authentication already read and validated this public configuration.
		const state = authenticatedState === undefined ? await readEncryptionState(db) : authenticatedState;
		if (!state || principal.scope === 'vault') return corsResponse({ encryption: state }, 200, { 'Cache-Control': 'no-store' });
		return corsResponse({ encryption: scopedEncryptionState(state, principal.folderPath) }, 200, { 'Cache-Control': 'no-store' });
	}
	if (path !== '/encryption/metadata' || request.method !== 'POST' || principal.scope !== 'vault') return null;
	return handleEncryptionMetadata(request, db);
}
