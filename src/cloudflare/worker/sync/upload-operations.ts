import { FILE_PATH_MATCH, filePathArgs, fileRevisionGuard } from './file-identity';
import { corsResponse } from '../http/cors';
import { reminderOperationDay } from '@/protocol/reminder-operation';
import { OPERATION_FLOOR, OPERATION_VALID } from '../d1/operation-receipts';
import { fileNamespaceGuard, namespacePredicate, FileNamespaceConflictError } from './file-namespace';
import type { RestoreFileRequest, UploadResult } from '@/protocol/sync-types';
import { sha256Hex } from '@/platform/sha256';
import { queryRows } from '../d1/db';

export function decodeReceipt(json: string): UploadResult {
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

type UploadOperationPayload = {
	path: string; hash: string; size: number; contentType: string; expectedHash: string | null;
} | (Omit<RestoreFileRequest, 'operationId'> & { kind: 'restore' });
type OperationRow = { request_hash: string | null; response_json: string | null };

async function operationFor(id: unknown, payload: UploadOperationPayload): Promise<UploadOperation | null> {
	const day = typeof id === 'string' ? reminderOperationDay(id) : null;
	return typeof id === 'string' && day !== null ? { id, day, requestHash: await sha256Hex(JSON.stringify(payload)) } : null;
}

/** `row` is the stored receipt, an empty row for a new operation inside the retry
 * window, or null for one outside it. */
function resolveOperation(operation: UploadOperation | null, payload: UploadOperationPayload, row: OperationRow | null): UploadOperation | Response {
	if (!operation) return corsResponse({ success: false, path: payload.path, error: 'A stable upload operationId is required. Update Crate before syncing.', code: 'validation' }, 428);
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

export async function beginUploadOperation(db: D1Database, id: unknown, payload: UploadOperationPayload): Promise<UploadOperation | Response> {
	const operation = await operationFor(id, payload);
	const row = operation && await db.prepare(`SELECT request_hash, response_json FROM upload_operations WHERE operation_id = ?
		UNION ALL SELECT NULL, NULL WHERE NOT EXISTS (SELECT 1 FROM upload_operations WHERE operation_id = ?)
		AND ${OPERATION_VALID} LIMIT 1`).bind(operation.id, operation.id, operation.day, operation.day).first<OperationRow>();
	return resolveOperation(operation, payload, row);
}

/** Reads every member's receipt in one query, so staging a batch costs the same at
 * any size. Each result matches `beginUploadOperation`'s. */
export async function beginUploadOperations(db: D1Database, requests: Array<{ id: unknown; payload: UploadOperationPayload }>): Promise<Array<UploadOperation | Response>> {
	const operations = await Promise.all(requests.map(({ id, payload }) => operationFor(id, payload)));
	const known = operations.filter((operation): operation is UploadOperation => operation !== null);
	const rows = known.length ? await queryRows<OperationRow & { id: string; valid: number }>(db.prepare(`SELECT
    json_extract(ids.value, '$[0]') AS id, o.request_hash, o.response_json,
    json_extract(ids.value, '$[1]') >= ${OPERATION_FLOOR}
      AND json_extract(ids.value, '$[1]') <= CAST(unixepoch('now') / 86400 AS INTEGER) AS valid
    FROM json_each(?) ids LEFT JOIN upload_operations o ON o.operation_id = json_extract(ids.value, '$[0]')`)
		.bind(JSON.stringify(known.map(operation => [operation.id, operation.day])))) : [];
	const receipts = new Map(rows.map(row => [row.id, row]));
	return requests.map(({ payload }, index) => {
		const operation = operations[index] ?? null;
		const row = operation ? receipts.get(operation.id) : undefined;
		return resolveOperation(operation, payload, row && (row.response_json || row.valid) ? row : null);
	});
}

/** Persist success AND rejected preconditions in the same transaction as CAS.
 * A request that once failed may never become a new write on a later retry. */
export function recordUploadReceipt(db: D1Database, operation: UploadOperation, file: { path: string; hash: string; objectKey: string }): D1PreparedStatement {
	const namespace = fileNamespaceGuard(file.path);
	const conflict = namespacePredicate(file.path);
	const revision = fileRevisionGuard(file.path, file.objectKey);
	return db.prepare(`INSERT INTO upload_operations (operation_id, request_hash, response_json)
		SELECT ?, ?, CASE WHEN ${OPERATION_VALID} THEN
			CASE WHEN ${revision.sql}
			THEN json_object('success', json('true'), 'path', ?, 'hash', ?, 'revision', ?)
			ELSE json_object('success', json('false'), 'path', ?, 'status', 409,
				'code', CASE WHEN ${namespace.sql} THEN 'version_conflict' ELSE 'namespace_conflict' END,
				'error', 'Remote file or namespace changed since it was read',
				'currentHash', (SELECT hash FROM files WHERE ${FILE_PATH_MATCH}),
				'conflictingPath', (SELECT path FROM files WHERE ${conflict.sql} LIMIT 1)) END
		ELSE NULL END WHERE NOT EXISTS (SELECT 1 FROM upload_operations WHERE operation_id = ?)
		RETURNING response_json`)
		.bind(operation.id, operation.requestHash, operation.day, operation.day, ...revision.args,
			file.path, file.hash, file.objectKey, file.path, ...namespace.args, ...filePathArgs(file.path), ...conflict.args, operation.id);
}
