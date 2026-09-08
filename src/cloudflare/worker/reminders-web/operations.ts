import { sha256HexBytes } from '../auth';
import { corsResponse } from '../cors';
import type { CommitEffects } from '../commit-effects';
import { reminderOperationDay } from '@/protocol/reminder-operation';
import { expiredReminderOperation, REMINDER_OPERATION_VALID } from './operation-expiry';

export interface ReminderOperation { id: string; requestHash: string; day: number }
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}
export async function beginReminderOperation(db: D1Database, body: Record<string, unknown>, action: string): Promise<ReminderOperation | Response> {
	if (typeof body.operationId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.operationId)) return corsResponse({ error: 'A stable operationId is required. Reload Crate before saving.' }, 428);
	const requestHash = await sha256HexBytes(new TextEncoder().encode(JSON.stringify(canonical({ action, body }))));
	const receipt = await readReminderReceipt(db, { id: body.operationId, requestHash });
	if (receipt) return receipt;
	const day = reminderOperationDay(body.operationId);
	if (day === null || !await db.prepare(`SELECT 1 AS valid WHERE ${REMINDER_OPERATION_VALID}`).bind(day, day).first()) return expiredReminderOperation();
	return { id: body.operationId, requestHash, day };
}
async function readReminderReceipt(db: D1Database, operation: Pick<ReminderOperation, 'id' | 'requestHash'>): Promise<Response | null> {
	const row = await db.prepare('SELECT request_hash, response_json FROM reminder_operations WHERE operation_id = ?').bind(operation.id).first<{ request_hash: string; response_json: string }>();
	if (!row) return null;
	if (row.request_hash !== operation.requestHash) {
		return corsResponse({ error: 'An operation ID cannot be reused for different changes.', code: 'operation_mismatch' }, 409);
	}
	return corsResponse(JSON.parse(row.response_json));
}
export function reminderOperationEffects(db: D1Database, operation: ReminderOperation, response: Record<string, unknown>, createdId?: string): CommitEffects {
	return files => {
		const predicate = files.map(() => 'EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)').join(' AND ');
		const bindings = files.flatMap(file => [file.path, file.storageKey]);
		return [
			// An operation can expire while R2 is being staged. A NOT NULL failure
			// aborts the entire D1 batch, including both files of a project move.
			db.prepare(`INSERT INTO reminder_operations (operation_id, request_hash, response_json)
				SELECT ?, ?, CASE WHEN ${REMINDER_OPERATION_VALID} THEN ? ELSE NULL END WHERE ${predicate}`)
				.bind(operation.id, operation.requestHash, operation.day, operation.day, JSON.stringify(response), ...bindings),
			...(createdId ? [db.prepare(`INSERT INTO reminder_identities (reminder_id, created_operation_id) SELECT ?, ? WHERE ${predicate}`)
				.bind(createdId, operation.id, ...bindings)] : []),
		];
	};
}
