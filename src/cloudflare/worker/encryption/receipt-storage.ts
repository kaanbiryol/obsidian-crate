import { MAX_ENCRYPTED_REMINDER_ACK } from '../../../encryption/receipt-format';
import type { SqlGuard } from '../d1/db';

const CHUNK_SIZE = 512 * 1024;
const MAX_CHUNKS = Math.ceil((MAX_ENCRYPTED_REMINDER_ACK + 4096) / CHUNK_SIZE);
type ReceiptKind = 'reminder' | 'upload' | 'reading';

/** Run these statements and the parent receipt write in the SAME D1 batch.
 * Ciphertext is ASCII; each row stays below D1's value/row limit. The caller's
 * commit predicate also guards the chunks, so rejected writes publish neither.
 * Maintenance deletes the chunks with their receipt (`pruneOperationReceipts`). */
export function prepareEncryptedReceipt(db: D1Database, kind: ReceiptKind, id: string, response: Record<string, unknown>,
	guard: SqlGuard<string | number>): { json: string; statements: D1PreparedStatement[] } {
	const json = JSON.stringify(response);
	if (json.length <= CHUNK_SIZE) return { json, statements: [] };
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !/^[\x20-\x7e]*$/.test(json)) throw new Error('Invalid encrypted receipt');
	const count = Math.ceil(json.length / CHUNK_SIZE);
	if (count > MAX_CHUNKS) throw new Error('Encrypted receipt is too large');
	return { json: JSON.stringify({ e2eeChunks: count }),
		statements: Array.from({ length: count }, (_, index) => db.prepare(`INSERT INTO operation_chunks(kind, operation_id, idx, body)
			SELECT ?, ?, ?, ? WHERE ${guard.sql}`).bind(kind, id, index, json.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE), ...guard.args)) };
}

export async function readEncryptedReceipt(db: D1Database, kind: ReceiptKind, id: string, json: string): Promise<Record<string, unknown>> {
	const response = JSON.parse(json) as Record<string, unknown>;
	const count = response.e2eeChunks;
	if (count === undefined) return response;
	if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) throw new Error('Invalid encrypted receipt chunks');
	const rows = await db.prepare('SELECT idx, body FROM operation_chunks WHERE kind = ? AND operation_id = ? ORDER BY idx')
		.bind(kind, id).all<{ idx: number; body: string }>();
	if (rows.results.length !== count || rows.results.some((row, index) => row.idx !== index || row.body.length > CHUNK_SIZE)) throw new Error('Encrypted receipt is incomplete');
	return JSON.parse(rows.results.map(row => row.body).join('')) as Record<string, unknown>;
}
