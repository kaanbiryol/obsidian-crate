/**
 * Kept as an awaitable boundary for callers, but intentionally performs no DDL.
 * The provisioner applies versioned migrations before uploading a Worker.
 */
export function initDb(_db: D1Database): Promise<void> {
	return Promise.resolve();
}

const CHANGELOG_RETENTION_DAYS = 30;

export async function maybePruneChangelog(db: D1Database): Promise<void> {
	if (Math.random() > 0.05) return;
	try {
		await db.prepare(
			"DELETE FROM changelog WHERE created_at < datetime('now', '-' || ? || ' days')"
		).bind(CHANGELOG_RETENTION_DAYS).run();
	} catch { /* non-fatal */ }
}

export async function queryRows<T = Record<string, unknown>>(statement: D1PreparedStatement): Promise<T[]> {
	const result = await statement.all();
	return (Array.isArray(result?.results) ? result.results : []) as T[];
}
