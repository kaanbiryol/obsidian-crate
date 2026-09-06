import { queryRows } from './db';

/** Immutable keys are never reused by a later mutation or restore. */
export async function findReferencedStorageKeys(db: D1Database, keys: readonly string[]): Promise<Set<string>> {
	const referenced = new Set<string>();
	// Each key is bound twice; stay within D1's 100-parameter limit.
	for (let offset = 0; offset < keys.length; offset += 50) {
		const chunk = keys.slice(offset, offset + 50);
		const placeholders = chunk.map(() => '?').join(', ');
		const rows = await queryRows<{ storage_key: string }>(db.prepare(`
			SELECT storage_key FROM files WHERE storage_key IN (${placeholders})
			UNION SELECT storage_key FROM file_versions WHERE storage_key IN (${placeholders})
		`).bind(...chunk, ...chunk));
		for (const row of rows) referenced.add(row.storage_key);
	}
	return referenced;
}
