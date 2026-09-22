import { sha256Hex } from '../auth';
import { reminderOperationDay } from '@/protocol/reminder-operation';
import { REMINDER_OPERATION_VALID } from '../reminders-web/operation-expiry';
import { ReadingError, readingResponse, type ReadingPolicy } from './common';
import type { AuthPrincipal } from '../authenticate';
import type { CommitEffects } from '../commit-effects';

export interface ReadingOperation { id: string; principal: string; generation: string; hash: string; day: number }
export async function beginOperation(db: D1Database, principal: AuthPrincipal, current: ReadingPolicy, body: Record<string, unknown>, action: string) {
  if (typeof body.operationId !== 'string') throw new ReadingError('A saved operation ID is required.', 428);
  const day = reminderOperationDay(body.operationId);
  const hash = await sha256Hex(JSON.stringify({ action, body }));
  const saved = await db.prepare('SELECT * FROM reading_operations WHERE operation_id = ?').bind(body.operationId)
    .first<{ principal_id: string; generation: string; request_hash: string; response_json: string }>();
  if (saved) {
    if (saved.principal_id !== principal.tokenId || saved.generation !== current.generation || saved.request_hash !== hash) throw new ReadingError('This operation ID belongs to a different save.', 409, 'operation_mismatch');
    return readingResponse(JSON.parse(saved.response_json));
  }
  if (day === null || !await db.prepare(`SELECT 1 WHERE ${REMINDER_OPERATION_VALID}`).bind(day, day).first()) {
    throw new ReadingError('This change is too old to retry safely. Compare your library before saving it again.', 410, 'operation_expired');
  }
  return { id: body.operationId, principal: principal.tokenId, generation: current.generation, hash, day };
}
export function operationStatement(db: D1Database, op: ReadingOperation, response: unknown, predicate = '1', args: string[] = []) {
  return db.prepare(`INSERT INTO reading_operations(operation_id, principal_id, generation, request_hash, response_json, day)
    SELECT ?, ?, ?, ?, CASE WHEN ${REMINDER_OPERATION_VALID}
      AND EXISTS (SELECT 1 FROM reading_policy WHERE enabled=1 AND generation=?)
      AND EXISTS (SELECT 1 FROM auth_tokens WHERE id=? AND (expires_at IS NULL OR expires_at > ?))
      THEN ? ELSE NULL END, ? WHERE ${predicate}`)
    .bind(op.id, op.principal, op.generation, op.hash, op.day, op.day, op.generation, op.principal, Date.now(), JSON.stringify(response), op.day, ...args);
}
export function operationEffects(db: D1Database, op: ReadingOperation, response: unknown): CommitEffects {
  return files => [operationStatement(db, op, response,
    files.map(() => 'EXISTS (SELECT 1 FROM files WHERE path=? AND storage_key=?)').join(' AND '), files.flatMap(f => [f.path, f.storageKey]))];
}
