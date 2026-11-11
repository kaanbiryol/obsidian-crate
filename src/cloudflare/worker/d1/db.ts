import { DEPLOYMENT_FENCE_KEY } from '../../../protocol/deployment-fence';

const CHANGELOG_RETENTION_DAYS = 30;

/** A SQL condition and its bound values, composed into larger statements. */
export interface SqlGuard<Value = string> {
	sql: string;
	args: Value[];
}

/** All guards must hold. Conditions and values stay in order, so placeholders keep their values. */
export function allGuards<Value>(...guards: ReadonlyArray<SqlGuard<Value>>): SqlGuard<Value> {
	return { sql: guards.map(guard => guard.sql).join(' AND '), args: guards.flatMap(guard => guard.args) };
}

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

/** Deletes the expired rows at the start of the changelog in sequence order, so the
 * retained changelog stays contiguous. Entries are written in sequence order, so the
 * walk stops at the first one still retained and needs no index on `created_at`.
 * Returns true when more rows may remain. */
export async function pruneChangelog(db: D1Database): Promise<boolean> {
	// A statement that runs earlier sees an earlier clock, so it selects a subset of these rows.
	const expired: SqlGuard<unknown> = { sql: `SELECT seq FROM changelog
			WHERE seq < COALESCE((SELECT seq FROM changelog WHERE created_at >= datetime('now', '-' || ? || ' days') ORDER BY seq LIMIT 1),
				(SELECT MAX(seq) FROM changelog))
			AND seq < (SELECT MAX(seq) FROM changelog) ORDER BY seq LIMIT ?`, args: [CHANGELOG_RETENTION_DAYS, MAINTENANCE_DELETE_LIMIT] };
	return changedRows(await db.prepare(`DELETE FROM changelog WHERE seq IN (${expired.sql})`).bind(...expired.args).run()) === MAINTENANCE_DELETE_LIMIT;
}

/** Sets a `maintenance_state` value. Conflicts keep the row's `updated_at`; the
 * statement can run alone or in a batch. */
/** The stored value for `key`, or null when no row exists. */
export async function readMaintenanceValue(db: D1Database, key: string): Promise<string | null> {
	return (await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null;
}

/** A deployment, upgrade or server deletion holds the fence, so background work waits. */
export async function deploymentFenceHeld(db: D1Database): Promise<boolean> {
	return Boolean(await db.prepare(`SELECT 1 FROM maintenance_state WHERE key='${DEPLOYMENT_FENCE_KEY}'`).first());
}

export function putMaintenanceValue(db: D1Database, key: string, value: string): D1PreparedStatement {
	return db.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value);
}

export async function queryRows<T = Record<string, unknown>>(statement: D1PreparedStatement): Promise<T[]> {
	const result = await statement.all();
	return (Array.isArray(result?.results) ? result.results : []) as T[];
}
