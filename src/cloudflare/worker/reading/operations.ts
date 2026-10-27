import { reminderOperationDay } from '@/protocol/reminder-operation';
import { OPERATION_VALID } from '../operation-receipts';
import { fileRevisionsGuard } from '../sync/file-identity';
import { ReadingError, readingResponse } from './common';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import type { AuthPrincipal } from '../auth/authenticate';
import type { CommitEffects } from '../commit-effects';
import { sha256Hex } from '@/platform/sha256';

/** `reminderFolder` is read with the receipt, for the commit's reminder projection check. */
export interface ReadingOperation { id: string; principal: string; generation: string; hash: string; day: number; reminderFolder: string | null }
export async function beginOperation(db: D1Database, principal: AuthPrincipal, current: ReadingPolicy, body: Record<string, unknown>, action: string) {
	if (typeof body.operationId !== 'string') throw new ReadingError('A saved operation ID is required.', 428);
	const day = reminderOperationDay(body.operationId);
	const hash = await sha256Hex(JSON.stringify({ action, body }));
	// One read: a saved receipt is replayed even after its day leaves the retry window.
	const saved = await db.prepare(`SELECT r.principal_id, r.generation, r.request_hash, r.response_json,
    (SELECT 1 WHERE ${OPERATION_VALID}) AS retryable, (SELECT folder_path FROM notification_policy WHERE id = 1) AS reminder_folder
    FROM (SELECT 1) LEFT JOIN reading_operations r ON r.operation_id = ?`).bind(day, day, body.operationId)
		.first<{ principal_id: string | null; generation: string | null; request_hash: string | null; response_json: string | null; retryable: number | null; reminder_folder: string | null }>();
	if (saved?.response_json != null) {
		if (saved.principal_id !== principal.tokenId || saved.generation !== current.generation || saved.request_hash !== hash) throw new ReadingError('This operation ID belongs to a different save.', 409, 'operation_mismatch');
		return readingResponse(JSON.parse(saved.response_json));
	}
	if (day === null || !saved?.retryable) {
		throw new ReadingError('This change is too old to retry safely. Compare your library before saving it again.', 410, 'operation_expired');
	}
	return { id: body.operationId, principal: principal.tokenId, generation: current.generation, hash, day, reminderFolder: saved.reminder_folder };
}
export function operationStatement(db: D1Database, op: ReadingOperation, response: unknown, predicate = '1', args: string[] = []) {
	return db.prepare(`INSERT INTO reading_operations(operation_id, principal_id, generation, request_hash, response_json, day)
    SELECT ?, ?, ?, ?, CASE WHEN ${OPERATION_VALID}
      AND EXISTS (SELECT 1 FROM reading_policy WHERE generation=?)
      AND EXISTS (SELECT 1 FROM auth_tokens WHERE id=? AND (expires_at IS NULL OR expires_at > ?))
      THEN ? ELSE NULL END, ? WHERE ${predicate}`)
		.bind(op.id, op.principal, op.generation, op.hash, op.day, op.day, op.generation, op.principal, Date.now(), JSON.stringify(response), op.day, ...args);
}
export function operationEffects(db: D1Database, op: ReadingOperation, response: unknown): CommitEffects {
	return files => {
		const revisions = fileRevisionsGuard(files);
		return [operationStatement(db, op, response, revisions.sql, revisions.args)];
	};
}
