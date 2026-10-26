import { prepareEncryptedReceipt, readEncryptedReceipt } from '../encryption/receipt-storage';
import { fileRevisionsGuard } from '../sync/file-identity';
import { reminderRequestHash } from './request-hash';
import { corsResponse } from '../cors';
import type { CommitEffects } from '../commit-effects';
import { reminderOperationDay, isReminderOperationId } from '@/protocol/reminder-operation';
import { OPERATION_VALID, isRetryableOperationDay } from '../operation-receipts';

function expiredReminderOperation(): Response {
	return corsResponse({ code: 'operation_expired', error: 'This change is outside the server’s retry window. An earlier attempt may have synced. Export it and compare your current reminders before restoring missing work.' }, 410);
}

export interface ReminderOperation { id: string; requestHash: string; day: number }
export async function beginReminderOperation(db: D1Database, body: Record<string, unknown>, action: string): Promise<ReminderOperation | Response> {
	if (!isReminderOperationId(body.operationId)) return corsResponse({ error: 'A stable operationId is required. Reload Crate before saving.' }, 428);
	const requestHash = await reminderRequestHash(action, body);
	const receipt = await readReminderReceipt(db, { id: body.operationId, requestHash });
	if (receipt) return receipt;
	const day = reminderOperationDay(body.operationId);
	if (day === null || !await isRetryableOperationDay(db, day)) return expiredReminderOperation();
	return { id: body.operationId, requestHash, day };
}
async function readReminderReceipt(db: D1Database, operation: Pick<ReminderOperation, 'id' | 'requestHash'>): Promise<Response | null> {
	const row = await db.prepare('SELECT request_hash, response_json FROM reminder_operations WHERE operation_id = ?').bind(operation.id).first<{ request_hash: string; response_json: string }>();
	if (!row) return null;
	if (row.request_hash !== operation.requestHash) {
		return corsResponse({ error: 'An operation ID cannot be reused for different changes.', code: 'operation_mismatch' }, 409);
	}
	return corsResponse(await readEncryptedReceipt(db, 'reminder', operation.id, row.response_json));
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
			db.prepare(`INSERT INTO reminder_operations (operation_id, request_hash, response_json)
				SELECT ?, ?, CASE WHEN ${OPERATION_VALID} THEN ? ELSE NULL END WHERE ${predicate}`)
				.bind(operation.id, operation.requestHash, operation.day, operation.day, receipt.json, ...bindings),
			...(createdId ? [db.prepare(`INSERT INTO reminder_identities (reminder_id, created_operation_id) SELECT ?, ? WHERE ${predicate}`)
				.bind(createdId, operation.id, ...bindings)] : []),
		];
	};
}
