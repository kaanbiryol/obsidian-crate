import { sha256Hex } from './auth';
import { corsResponse } from './cors';
import { reminderOperationDay } from '@/protocol/reminder-operation';
import { REMINDER_OPERATION_VALID } from './reminders-web/operation-expiry';
import { fileNamespaceGuard, namespacePredicate, FileNamespaceConflictError } from './file-namespace';
import type { UploadResult } from '@/protocol/sync-types';

function decodeReceipt(json: string): UploadResult {
	const result = JSON.parse(json) as UploadResult & { conflictingPath?: string | null };
	if (result.conflictingPath) result.error = new FileNamespaceConflictError(result.path, result.conflictingPath).message;
	else delete result.conflictingPath;
	return result;
}

export interface UploadOperation { id: string; requestHash: string; day: number }

export async function readUploadReceipt(db: D1Database, operation: Pick<UploadOperation, 'id' | 'requestHash'>): Promise<UploadResult | null> {
	const row = await db.prepare('SELECT request_hash, response_json FROM upload_operations WHERE operation_id = ?')
		.bind(operation.id).first<{ request_hash: string; response_json: string }>();
	if (!row) return null;
	if (row.request_hash !== operation.requestHash) return { success: false, path: '', status: 409, code: 'operation_mismatch', error: 'An upload operation ID cannot be reused for different bytes or preconditions.' };
	return decodeReceipt(row.response_json);
}

export async function beginUploadOperation(db: D1Database, id: unknown, payload: {
	path: string; hash: string; size: number; contentType: string; expectedHash: string | null;
}): Promise<UploadOperation | Response> {
	const day = typeof id === 'string' ? reminderOperationDay(id) : null;
	if (typeof id !== 'string' || day === null) return corsResponse({ success: false, path: payload.path, error: 'A stable upload operationId is required. Update Crate before syncing.', code: 'validation' }, 428);
	const operation = { id, day, requestHash: await sha256Hex(JSON.stringify(payload)) };
	const row = await db.prepare(`SELECT request_hash, response_json FROM upload_operations WHERE operation_id = ?
		UNION ALL SELECT NULL, NULL WHERE NOT EXISTS (SELECT 1 FROM upload_operations WHERE operation_id = ?)
		AND ${REMINDER_OPERATION_VALID} LIMIT 1`).bind(id, id, day, day).first<{ request_hash: string | null; response_json: string | null }>();
	if (row?.response_json) {
		if (row.request_hash !== operation.requestHash) return corsResponse({ success: false, path: payload.path, status: 409, code: 'operation_mismatch', error: 'An upload operation ID cannot be reused for different bytes or preconditions.' }, 409);
		const receipt = decodeReceipt(row.response_json);
		return corsResponse(receipt, receipt.status ?? 200);
	}
	if (!row) {
		return corsResponse({ success: false, path: payload.path, code: 'operation_expired', error: 'This upload is outside the 180-day retry window. Preserve your local files and compare the server before resetting sync.' }, 410);
	}
	return operation;
}

/** Persist success AND rejected preconditions in the same transaction as CAS.
 * A request that once failed may never become a new write on a later retry. */
export function recordUploadReceipt(db: D1Database, operation: UploadOperation, file: { path: string; hash: string; objectKey: string }): D1PreparedStatement {
	const namespace = fileNamespaceGuard(file.path);
	const conflict = namespacePredicate(file.path);
	return db.prepare(`INSERT INTO upload_operations (operation_id, request_hash, response_json)
		SELECT ?, ?, CASE WHEN ${REMINDER_OPERATION_VALID} THEN
			CASE WHEN EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)
			THEN json_object('success', json('true'), 'path', ?, 'hash', ?, 'revision', ?)
			ELSE json_object('success', json('false'), 'path', ?, 'status', 409,
				'code', CASE WHEN ${namespace.sql} THEN 'version_conflict' ELSE 'namespace_conflict' END,
				'error', 'Remote file or namespace changed since it was read',
				'currentHash', (SELECT hash FROM files WHERE path = ?),
				'conflictingPath', (SELECT path FROM files WHERE ${conflict.sql} LIMIT 1)) END
		ELSE NULL END WHERE NOT EXISTS (SELECT 1 FROM upload_operations WHERE operation_id = ?)`)
		.bind(operation.id, operation.requestHash, operation.day, operation.day, file.path, file.objectKey,
			file.path, file.hash, file.objectKey, file.path, ...namespace.args, file.path, ...conflict.args, operation.id);
}
