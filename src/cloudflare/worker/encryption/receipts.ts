import { readEncryptedReceipt } from './receipt-storage';
import { readEncryptionState } from './state';
import { corsResponse } from '../cors';
import { reminderOperationDay } from '../../../protocol/reminder-operation';
import { OPERATION_VALID } from '../operation-expiry';

/** The converted pre-encryption receipt of an upload, and whether it may still be retried. */
export async function handleUploadReceipt(request: Request, db: D1Database): Promise<Response> {
	const id = new URL(request.url).searchParams.get('operationId') ?? '';
	const day = reminderOperationDay(id);
	if (day === null) return corsResponse({ error: 'Invalid upload identity' }, 400);
	const row = await db.prepare('SELECT response_json FROM upload_operations WHERE operation_id = ?').bind(id).first<{ response_json: string }>();
	const receipt = row ? (await readEncryptedReceipt(db, 'upload', id, row.response_json) as { e2eeLegacy?: { vault: string } }).e2eeLegacy : undefined;
	const retryValid = Boolean(await db.prepare(`SELECT 1 WHERE ${OPERATION_VALID}`).bind(day, day).first());
	return corsResponse({ envelope: receipt?.vault ?? null, retryValid });
}

/** The deletion receipt that consumed a file revision, if any. */
export async function handleDeletionPrecondition(request: Request, db: D1Database): Promise<Response> {
	const params = new URL(request.url).searchParams;
	const row = await db.prepare('SELECT consumed_hash AS hash FROM file_deletion_receipts WHERE consumed_revision = ? AND path = ?').bind(params.get('revision'), params.get('path')).first<{ hash: string }>();
	return corsResponse({ receipt: row });
}

/** The converted pre-encryption receipt of a reminder operation, for one encrypted folder. */
export async function handleReminderReceipt(request: Request, db: D1Database): Promise<Response> {
	const id = new URL(request.url).searchParams.get('operationId');
	const folder = new URL(request.url).searchParams.get('folderPath');
	const state = await readEncryptionState(db);
	const scope = state?.scopes.find(scope => scope.folderPath === folder);
	if (!id || !scope) return corsResponse({ error: 'Invalid receipt scope' }, 400);
	const row = await db.prepare('SELECT response_json FROM reminder_operations WHERE operation_id = ?').bind(id).first<{ response_json: string }>();
	const converted = row ? (await readEncryptedReceipt(db, 'reminder', id, row.response_json) as { e2eeLegacy?: { scopes: Array<{ id: string; envelope: string }> } }).e2eeLegacy : undefined;
	return corsResponse({ envelope: converted?.scopes.find(item => item.id === scope.id)?.envelope ?? null });
}
