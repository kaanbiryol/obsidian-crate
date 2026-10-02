import { MAX_ENCRYPTED_REMINDER_ACK } from '../../encryption/receipt-format';

const CHUNK_SIZE = 512 * 1024;
const MAX_CHUNKS = Math.ceil((MAX_ENCRYPTED_REMINDER_ACK + 4096) / CHUNK_SIZE);
const PREFIX = 'e2ee:receipt:';
type ReceiptKind = 'reminder' | 'upload' | 'reading';

function chunkKey(kind: ReceiptKind, id: string, index: number): string {
	return `${PREFIX}${kind}:${id}:${String(index).padStart(3, '0')}`;
}

/** Run these statements and the parent receipt write in the SAME D1 batch.
 * Ciphertext is ASCII; each row stays below D1's value/row limit. The caller's
 * commit predicate also guards the chunks, so rejected writes publish neither. */
export function prepareEncryptedReceipt(db: D1Database, kind: ReceiptKind, id: string, response: Record<string, unknown>,
	guard: { sql: string; args: (string | number)[] }): { json: string; statements: D1PreparedStatement[] } {
	const json = JSON.stringify(response);
	if (json.length <= CHUNK_SIZE) return { json, statements: [] };
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !/^[\x20-\x7e]*$/.test(json)) throw new Error('Invalid encrypted receipt');
	const count = Math.ceil(json.length / CHUNK_SIZE);
	if (count > MAX_CHUNKS) throw new Error('Encrypted receipt is too large');
	return { json: JSON.stringify('e2eeLegacy' in response ? { e2eeLegacy: { chunks: count } } : { e2eeChunks: count }),
		statements: Array.from({ length: count }, (_, index) => db.prepare(`INSERT INTO maintenance_state(key, value)
			SELECT ?, ? WHERE ${guard.sql}`).bind(chunkKey(kind, id, index), json.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE), ...guard.args)) };
}

export async function readEncryptedReceipt(db: D1Database, kind: ReceiptKind, id: string, json: string): Promise<Record<string, unknown>> {
	const response = JSON.parse(json) as Record<string, unknown>;
	const legacy = response.e2eeLegacy as { chunks?: unknown } | undefined;
	const count = legacy?.chunks ?? response.e2eeChunks;
	if (count === undefined) return response;
	if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) throw new Error('Invalid encrypted receipt chunks');
	const keys = Array.from({ length: count }, (_, index) => chunkKey(kind, id, index));
	const rows = await db.prepare('SELECT key, value FROM maintenance_state WHERE key IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(keys)).all<{ key: string; value: string }>();
	const chunks = new Map(rows.results.map(row => [row.key, row.value]));
	if (chunks.size !== count || keys.some(key => !chunks.has(key) || chunks.get(key)!.length > CHUNK_SIZE)) throw new Error('Encrypted receipt is incomplete');
	return JSON.parse(keys.map(key => chunks.get(key)!).join('')) as Record<string, unknown>;
}

/** Expiry removes parents first. A bounded cursor eventually reclaims their
 * chunks; a concurrent transaction publishing a parent prevents deletion. */
export async function pruneEncryptedReceiptChunks(db: D1Database): Promise<void> {
	const cursorKey = 'e2ee:receipt-cleanup-cursor';
	const cursor = (await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(cursorKey).first<{ value: string }>())?.value ?? PREFIX;
	const page = await db.prepare('SELECT key FROM maintenance_state WHERE key > ? AND key >= ? AND key < ? ORDER BY key LIMIT 100')
		.bind(cursor, PREFIX, 'e2ee:receipt;').all<{ key: string }>();
	const candidates = page.results.flatMap(({ key }) => {
		const match = /^e2ee:receipt:(reminder|upload|reading):([A-Za-z0-9_-]{1,128}):\d{3}$/.exec(key);
		return match ? [{ key, kind: match[1], id: match[2] }] : [];
	});
	await db.batch([
		db.prepare(`WITH candidates AS (SELECT json_extract(value, '$.key') AS key,
			json_extract(value, '$.kind') AS kind, json_extract(value, '$.id') AS id FROM json_each(?))
			DELETE FROM maintenance_state WHERE key IN (SELECT key FROM candidates c
				WHERE NOT EXISTS (SELECT 1 FROM reminder_operations WHERE c.kind = 'reminder' AND operation_id = c.id)
				AND NOT EXISTS (SELECT 1 FROM upload_operations WHERE c.kind = 'upload' AND operation_id = c.id)
				AND NOT EXISTS (SELECT 1 FROM reading_operations WHERE c.kind = 'reading' AND operation_id = c.id))`)
			.bind(JSON.stringify(candidates)),
		page.results.length === 100
			? db.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(cursorKey, page.results.at(-1)!.key)
			: db.prepare('DELETE FROM maintenance_state WHERE key = ?').bind(cursorKey),
	]);
}
