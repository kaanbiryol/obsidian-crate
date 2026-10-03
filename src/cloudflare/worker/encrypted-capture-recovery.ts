import { readEncryptedReceipt } from './encrypted-receipt-storage';
import { reminderOperationDay } from '../../protocol/reminder-operation';
import { REMINDER_OPERATION_VALID } from './reminders-web/operation-expiry';
import { corsResponse } from './cors';

/** Vault-only recovery reads. No private request body or write is needed. */
export async function readCaptureRecovery(request: Request, db: D1Database): Promise<Response> {
  const id = new URL(request.url).searchParams.get('operationId') ?? '', day = reminderOperationDay(id);
  if (day === null) return corsResponse({ error: 'Invalid capture operation' }, 400);
  const receipts = [];
  for (const kind of ['reading', 'reminder'] as const) {
    const table = kind === 'reading' ? 'reading_operations' : 'reminder_operations';
    const row = await db.prepare(`SELECT request_hash, response_json FROM ${table} WHERE operation_id=?`).bind(id).first<{ request_hash: string; response_json: string }>();
    if (row) {
      const value = await readEncryptedReceipt(db, kind, id, row.response_json) as { e2eeLegacy?: { vault?: string }; encrypted?: string };
      if (!value.e2eeLegacy?.vault && !value.encrypted) return corsResponse({ error: 'Finish encryption before recovering captures' }, 409);
      receipts.push({ kind, requestHash: row.request_hash, envelope: value.e2eeLegacy?.vault, encrypted: value.encrypted });
    }
  }
  const retryValid = Boolean(await db.prepare(`SELECT 1 WHERE ${REMINDER_OPERATION_VALID}`).bind(day, day).first());
  return corsResponse({ receipts, retryValid }, 200, { 'Cache-Control': 'no-store' });
}
