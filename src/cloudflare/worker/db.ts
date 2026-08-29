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
