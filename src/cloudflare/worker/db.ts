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

export async function pruneChangelog(db: D1Database): Promise<void> {
	try {
		await db.prepare(
			`DELETE FROM changelog
			WHERE created_at < datetime('now', '-' || ? || ' days')
			AND seq < (SELECT MAX(seq) FROM changelog)`,
		).bind(CHANGELOG_RETENTION_DAYS).run();
	} catch { /* non-fatal */ }
}

export async function queryRows<T = Record<string, unknown>>(statement: D1PreparedStatement): Promise<T[]> {
	const result = await statement.all();
	return (Array.isArray(result?.results) ? result.results : []) as T[];
}
