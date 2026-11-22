import { corsResponse } from '../http/cors';
import { parseJsonObject } from '../http/request-validation';
import { HISTORY_RETENTION_MS_SQL } from '../sync/storage';
import { DAY_MS, isHistoryRetentionDays } from '../../../protocol/history-retention';

/** The retention in milliseconds, as statements that keep history read it. */
async function historyRetentionMs(db: D1Database): Promise<number> {
	const row = await db.prepare(`SELECT ${HISTORY_RETENTION_MS_SQL} AS ms`).first<{ ms: number }>();
	if (!row) throw new Error('Could not read history retention');
	return row.ms;
}

/** GET and POST /history-retention. A version expires once its `kept_at` is older than
 * the current retention, so a change applies to all kept history without rewriting it:
 * a shorter one lets maintenance remove older history, and a longer one extends
 * versions maintenance has not started to remove. */
export async function handleHistoryRetention(request: Request, db: D1Database): Promise<Response> {
	if (request.method === 'GET') return corsResponse({ days: await historyRetentionMs(db) / DAY_MS }, 200, { 'Cache-Control': 'no-store' });
	const parsed = await parseJsonObject(request);
	if (!parsed.ok) return parsed.response;
	const { days } = parsed.value;
	if (!isHistoryRetentionDays(days)) return corsResponse({ error: 'Choose 7, 14, 30, 60 or 90 days.' }, 400);
	await db.prepare(`INSERT INTO server_state(id, history_retention_days) VALUES (1, ?)
		ON CONFLICT(id) DO UPDATE SET history_retention_days = excluded.history_retention_days`).bind(days).run();
	return corsResponse({ days }, 200, { 'Cache-Control': 'no-store' });
}
