import { handleEncryptionPairing } from '../encryption/pairing';
import { readEncryptionState } from '../encryption/state';
import { handleDeletionPrecondition } from '../encryption/receipts';
import { handleEncryptionMetadata } from '../encryption/metadata';
import { handleEncryptionReset } from '../encryption/reset';
import { readFolderLabel } from '../encryption/folder-labels';
import { corsResponse } from '../http/cors';
import type { Env } from '../types';
import type { AuthenticatedRouteContext } from '../router';

/** Every session receives the public configuration and the encrypted recovery
 * bundle. The recovery key never leaves the client; API permissions remain scoped
 * by `routes/policy.ts`. */
export async function handleEncryptionRoute(
	request: Request,
	env: Env,
	{ path, method, principal, encryption }: Pick<AuthenticatedRouteContext, 'path' | 'method' | 'principal' | 'encryption'>,
): Promise<Response | null> {
	const db = env.DB;
	// Authentication already read and validated this public configuration.
	const state = async () => encryption === undefined ? await readEncryptionState(db) : encryption;
	if (path === '/encryption/reset') return handleEncryptionReset(request, env, principal);
	if (path === '/encryption/pairing' && ['GET', 'POST'].includes(method)) return handleEncryptionPairing(request, db, principal, await state());
	if (path === '/encryption/deletion-precondition' && method === 'GET') return handleDeletionPrecondition(request, db);
	if (path === '/encryption' && method === 'GET') {
		const current = await state();
		const folderLabel = current && principal.scope === 'reminders' ? await readFolderLabel(db, principal.folderPath) : null;
		return corsResponse({ encryption: current, ...(folderLabel ? { folderPath: principal.folderPath, folderLabel } : {}) }, 200, { 'Cache-Control': 'no-store' });
	}
	if (path === '/encryption/metadata' && method === 'POST') return handleEncryptionMetadata(request, db);
	return null;
}
