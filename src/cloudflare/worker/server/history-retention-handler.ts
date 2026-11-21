import { corsResponse } from '../http/cors';
import { parseJsonObject } from '../http/request-validation';
import { HISTORY_RETENTION_MS_SQL } from '../sync/storage';
import { DAY_MS, isHistoryRetentionDays } from '../../../protocol/history-retention';

/** The retention in milliseconds, as statements that keep history read it. */
export async function historyRetentionMs(db: D1Database): Promise<number> {
	const row = await db.prepare(`SELECT ${HISTORY_RETENTION_MS_SQL} AS ms`).first<{ ms: number }>();
	if (!row) throw new Error('Could not read history retention');
	return row.ms;
}

/** GET and POST /history-retention. Changing it also re-times kept versions to their
 * commit time plus the new retention: a shorter one lets maintenance remove older
 * history, a longer one extends versions that have not expired yet. */
export async function handleHistoryRetention(request: Request, db: D1Database): Promise<Response> {
	const current = await historyRetentionMs(db) / DAY_MS;
	if (request.method === 'GET') return corsResponse({ days: current }, 200, { 'Cache-Control': 'no-store' });
	const parsed = await parseJsonObject(request);
	if (!parsed.ok) return parsed.response;
	const { days } = parsed.value;
	if (!isHistoryRetentionDays(days)) return corsResponse({ error: 'Choose 7, 14, 30, 60 or 90 days.' }, 400);
	const kept = `(CAST(unixepoch(created_at) AS INTEGER) + 1) * 1000 + ${days * DAY_MS}`;
	await db.batch([
		db.prepare(`INSERT INTO server_state(id, history_retention_days) VALUES (1, ?)
			ON CONFLICT(id) DO UPDATE SET history_retention_days = excluded.history_retention_days`).bind(days),
		...days === current ? [] : [days < current
			? db.prepare(`UPDATE file_versions SET expires_at = ${kept} WHERE expires_at > ${kept}`)
			// An expired row may already have lost its object, so it is never revived.
			: db.prepare(`UPDATE file_versions SET expires_at = ${kept} WHERE expires_at < ${kept} AND expires_at > ?`).bind(Date.now())],
	]);
	return corsResponse({ days }, 200, { 'Cache-Control': 'no-store' });
}
