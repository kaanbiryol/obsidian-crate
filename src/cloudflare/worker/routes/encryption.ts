import { readEncryptedReceipt } from '../encrypted-receipt-storage';
import { readCaptureRecovery } from '../encrypted-capture-recovery';
import { ENCRYPTION_FILE_PREFIX, readEncryptionState } from '../encryption-state';
import { validateFileDescriptor } from '../../../encryption/file-format';
import { parseJsonObject } from '../utils';
import { corsResponse } from '../cors';
import type { AuthPrincipal } from '../auth/index';
import { handleEncryptedSettings } from '../encrypted-settings';
import { reminderOperationDay } from '../../../protocol/reminder-operation';
import { REMINDER_OPERATION_VALID } from '../reminders-web/operation-expiry';
import type { EncryptionServerState } from '../../../encryption/server-state';

/** Control-plane reads never contain a plaintext key. Scoped sessions receive
 * only their own public scope, never the encrypted vault recovery bundle. */
export async function handleEncryptionRoute(request: Request, db: D1Database, path: string, principal: AuthPrincipal, authenticatedState?: EncryptionServerState | null): Promise<Response | null> {
	if (path === '/encryption/capture-recovery' && request.method === 'GET' && principal.scope === 'vault') return readCaptureRecovery(request, db);
	if (path === '/encryption/upload-receipt' && request.method === 'GET' && principal.scope === 'vault') {
		const id = new URL(request.url).searchParams.get('operationId') ?? '';
		const day = reminderOperationDay(id);
		if (day === null) return corsResponse({ error: 'Invalid upload identity' }, 400);
		const row = await db.prepare('SELECT response_json FROM upload_operations WHERE operation_id = ?').bind(id).first<{ response_json: string }>();
		const receipt = row ? (await readEncryptedReceipt(db, 'upload', id, row.response_json) as { e2eeLegacy?: { vault: string } }).e2eeLegacy : undefined;
		const retryValid = Boolean(await db.prepare(`SELECT 1 WHERE ${REMINDER_OPERATION_VALID}`).bind(day, day).first());
		return corsResponse({ envelope: receipt?.vault ?? null, retryValid });
	}
	if (path === '/encryption/deletion-precondition' && request.method === 'GET' && principal.scope === 'vault') {
		const params = new URL(request.url).searchParams;
		const row = await db.prepare('SELECT consumed_hash AS hash FROM file_deletion_receipts WHERE consumed_revision = ? AND path = ?').bind(params.get('revision'), params.get('path')).first<{ hash: string }>();
		return corsResponse({ receipt: row });
	}
	if (path === '/encryption/folders' && request.method === 'GET' && principal.scope === 'vault') {
		const rows = await db.prepare("SELECT folder_path FROM notification_policy UNION SELECT folder_path FROM auth_tokens WHERE scope = 'reminders' UNION SELECT folder_path FROM web_enrollment_tokens").all<{ folder_path: string | null }>();
		const reading = await db.prepare('SELECT folder_path FROM reading_policy WHERE id=1').first<{ folder_path: string }>();
		return corsResponse({ folders: rows.results.map(row => row.folder_path).filter(Boolean), readingFolder: reading?.folder_path ?? null });
	}
	if (path === '/reminders/encrypted-receipt' && request.method === 'GET') {
		const id = new URL(request.url).searchParams.get('operationId');
		const folder = new URL(request.url).searchParams.get('folderPath');
		const state = await readEncryptionState(db);
		const scope = state?.scopes.find(scope => scope.folderPath === folder);
		if (!id || !scope) return corsResponse({ error: 'Invalid receipt scope' }, 400);
		const row = await db.prepare('SELECT response_json FROM reminder_operations WHERE operation_id = ?').bind(id).first<{ response_json: string }>();
		const legacy = row ? (await readEncryptedReceipt(db, 'reminder', id, row.response_json) as { e2eeLegacy?: { scopes: Array<{ id: string; envelope: string }> } }).e2eeLegacy : undefined;
		return corsResponse({ envelope: legacy?.scopes.find(item => item.id === scope.id)?.envelope ?? null });
	}
	if (path === '/settings' && principal.scope === 'vault') return handleEncryptedSettings(request, db);
	if (path === '/encryption' && request.method === 'GET') {
		// Authentication already read and validated this public configuration.
		const state = authenticatedState === undefined ? await readEncryptionState(db) : authenticatedState;
		if (!state || principal.scope === 'vault') return corsResponse({ encryption: state }, 200, { 'Cache-Control': 'no-store' });
		return corsResponse({ encryption: { version: state.version, vaultId: state.vaultId, generation: state.generation,
			mode: state.mode, scope: state.scopes.find(scope => scope.folderPath === principal.folderPath) ?? null } }, 200, { 'Cache-Control': 'no-store' });
	}
	if (path !== '/encryption/metadata' || request.method !== 'POST' || principal.scope !== 'vault') return null;
	const parsed = await parseJsonObject(request);
	if (!parsed.ok) return parsed.response;
	const revisions = parsed.value.revisions;
	if (!Array.isArray(revisions) || revisions.length > 100 || revisions.some(id => typeof id !== 'string' || !id || id.length > 1024)) {
		return corsResponse({ error: 'Up to 100 file revisions are required' }, 400);
	}
	const rows = await db.prepare(`SELECT key, value FROM maintenance_state WHERE key IN (SELECT ? || value FROM json_each(?))`)
		.bind(ENCRYPTION_FILE_PREFIX, JSON.stringify(revisions)).all<{ key: string; value: string }>();
	const descriptors: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const row of rows.results) {
		const descriptor: unknown = JSON.parse(row.value);
		validateFileDescriptor(descriptor);
		descriptors[row.key.slice(ENCRYPTION_FILE_PREFIX.length)] = descriptor;
	}
	return corsResponse({ descriptors }, 200, { 'Cache-Control': 'no-store' });
}
