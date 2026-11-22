import { prepareEncryptedReceipt, readEncryptedReceipt } from '../encryption/receipt-storage';
import { fileRevisionsGuard } from '../sync/file-identity';
import { reminderRequestHash } from './request-hash';
import { corsResponse } from '../http/cors';
import type { CommitEffects } from '../sync/commit-effects';
import { reminderOperationDay, isReminderOperationId } from '@/protocol/reminder-operation';
import { OPERATION_VALID } from '../d1/operation-receipts';

function expiredReminderOperation(): Response {
	return corsResponse({ code: 'operation_expired', error: 'This change is outside the server’s retry window. An earlier attempt may have synced. Export it and compare your current reminders before restoring missing work.' }, 410);
}

export interface ReminderOperation { id: string; requestHash: string; day: number }
/** `arm` runs once the request is known to be a new command, before it can commit. */
export async function beginReminderOperation(db: D1Database, body: Record<string, unknown>, action: string, arm?: () => Promise<void>): Promise<ReminderOperation | Response> {
	const day = isReminderOperationId(body.operationId) ? reminderOperationDay(body.operationId) : null;
	if (!isReminderOperationId(body.operationId) || day === null) return corsResponse({ error: 'A stable operationId is required. Reload Crate before saving.' }, 428);
	const requestHash = await reminderRequestHash(action, body);
	// One read: a saved receipt is replayed even after its day leaves the retry window.
	const row = await db.prepare(`SELECT r.request_hash, r.response_json, (SELECT 1 WHERE ${OPERATION_VALID}) AS retryable
    FROM (SELECT 1) LEFT JOIN operations r ON r.kind = 'reminder' AND r.operation_id = ?`).bind(day, day, body.operationId)
		.first<{ request_hash: string | null; response_json: string | null; retryable: number | null }>();
	if (row?.request_hash != null && row.response_json != null) {
		if (row.request_hash !== requestHash) {
			return corsResponse({ error: 'An operation ID cannot be reused for different changes.', code: 'operation_mismatch' }, 409);
		}
		return corsResponse(await readEncryptedReceipt(db, 'reminder', body.operationId, row.response_json));
	}
	if (!row?.retryable) return expiredReminderOperation();
	await arm?.();
	return { id: body.operationId, requestHash, day };
}
export function reminderOperationEffects(db: D1Database, operation: ReminderOperation, response: Record<string, unknown>, createdId?: string): CommitEffects {
	return files => {
		const { sql: predicate, args: bindings } = fileRevisionsGuard(files);
		const receipt = typeof response.encrypted === 'string'
			? prepareEncryptedReceipt(db, 'reminder', operation.id, response, { sql: predicate, args: bindings })
			: { json: JSON.stringify(response), statements: [] };
		return [
			...receipt.statements,
			// An operation can expire while R2 is being staged. A NOT NULL failure
			// aborts the entire D1 batch, including both files of a project move.
			db.prepare(`INSERT INTO operations (kind, operation_id, request_hash, response_json)
				SELECT 'reminder', ?, ?, CASE WHEN ${OPERATION_VALID} THEN ? ELSE NULL END WHERE ${predicate}`)
				.bind(operation.id, operation.requestHash, operation.day, operation.day, receipt.json, ...bindings),
			...(createdId ? [db.prepare(`INSERT INTO reminder_identities (reminder_id) SELECT ? WHERE ${predicate}`)
				.bind(createdId, ...bindings)] : []),
		];
	};
}
