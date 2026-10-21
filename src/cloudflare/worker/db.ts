const CHANGELOG_RETENTION_DAYS = 30;

interface D1MutationResult {
	meta?: {
		changes?: number;
	};
}

export function changedRows(result: unknown): number {
	if (!result || typeof result !== 'object') return 0;
	const changes = (result as D1MutationResult).meta?.changes;
	return typeof changes === 'number' ? changes : 0;
}

export const MAINTENANCE_DELETE_LIMIT = 5000;

/** Deletes the oldest expired rows in (created_at, seq) index order, so the
 * retained changelog stays contiguous. Returns true when more rows may remain. */
export async function pruneChangelog(db: D1Database): Promise<boolean> {
	const result = await db.prepare(
			`DELETE FROM changelog WHERE seq IN (SELECT seq FROM changelog
			WHERE created_at < datetime('now', '-' || ? || ' days')
			AND seq < (SELECT MAX(seq) FROM changelog) ORDER BY created_at, seq LIMIT ?)`,
	).bind(CHANGELOG_RETENTION_DAYS, MAINTENANCE_DELETE_LIMIT).run();
	return changedRows(result) === MAINTENANCE_DELETE_LIMIT;
}

/** Sets a `maintenance_state` value. Conflicts keep the row's `updated_at`; the
 * statement can run alone or in a batch. */
export function putMaintenanceValue(db: D1Database, key: string, value: string): D1PreparedStatement {
	return db.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value);
}

export async function queryRows<T = Record<string, unknown>>(statement: D1PreparedStatement): Promise<T[]> {
	const result = await statement.all();
	return (Array.isArray(result?.results) ? result.results : []) as T[];
}
