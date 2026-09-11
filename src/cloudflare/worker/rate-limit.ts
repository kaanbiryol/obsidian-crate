import { sha256Hex } from './auth';
import { corsResponse } from './cors';

export interface NotificationRateLimiter { limit(input: { key: string }): Promise<{ success: boolean }> }
const actions = new Map([
	['POST /notifications/reminders-exchange', 10],
	['POST /notifications/reminders-enrollment-token', 10],
	['POST /notifications/subscribe', 30],
	['DELETE /notifications/subscribe', 30],
	['POST /notifications/test', 3],
]);
// Bounded fallback for older/local deployments without the edge binding. It is
// per isolate, not a global abuse limit; production deployments bind the API.
const fallback = new WeakMap<D1Database, { expires: number; count: number }>();
const denied = () => corsResponse({ error: 'Too many notification requests. Try again in a minute.' }, 429, { 'Retry-After': '60' });

export async function limitNotificationRequest(request: Request, db: D1Database, limiter?: NotificationRateLimiter): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith('/notifications/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return null;
	const action = `${request.method} ${url.pathname}`;
	const limit = actions.get(action);
	// Reject invented routes before authentication or any D1 operation.
	if (!limit) return corsResponse({ error: 'Not found' }, 404);
	const now = Date.now();
	if (limiter) {
		// One sender cannot consume every user's edge admission slot. Invalid
		// credentials never reach the authenticated database-write budgets.
		const address = await sha256Hex(request.headers.get('CF-Connecting-IP') ?? 'local');
		if (!(await limiter.limit({ key: `notification-writes:${url.host}:${address}` })).success) return denied();
	} else {
		let budget = fallback.get(db);
		if (!budget || budget.expires <= now) { budget = { expires: now + 60_000, count: 0 }; fallback.set(db, budget); }
		if (++budget.count > 60) return denied();
	}
	return null;
}

/** Charge only after a bearer or enrollment grant has been verified. Both
 * counters are conditional in one transaction; denied actions spend neither. */
export async function limitNotificationAction(request: Request, db: D1Database, actor: string): Promise<Response | null> {
	const url = new URL(request.url);
	const action = `${request.method} ${url.pathname}`;
	const limit = actions.get(action);
	if (!limit) return null;
	const now = Date.now();
	const midnight = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
	const dailyKey = url.pathname === '/notifications/reminders-exchange' ? 'notification-exchange-daily' : 'notification-daily';
	const key = await sha256Hex(`${actor}\0${action}`);
	const results = await db.batch<{ results: Array<{ count: number }> }>([
		db.prepare(`INSERT INTO request_rate_limits (key, count, expires_at)
			SELECT ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM request_rate_limits WHERE key = ? AND expires_at > ? AND count >= ?)
			ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
				expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
			WHERE expires_at <= ? OR count < 1000 RETURNING count`).bind(dailyKey, midnight, key, now, limit, now, now, now),
		db.prepare(`INSERT INTO request_rate_limits (key, count, expires_at)
			SELECT ?, 1, ? WHERE changes() = 1
			ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
				expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END`).bind(key, now + 60_000, now, now),
	]);
	if (results[0]?.results.length) return null;
	const daily = await db.prepare('SELECT count, expires_at FROM request_rate_limits WHERE key = ?').bind(dailyKey).first<{count: number; expires_at: number}>();
	if (daily && daily.expires_at > now && daily.count >= 1000) {
		return corsResponse({ error: 'The daily notification request budget is exhausted. Try again tomorrow.' }, 429,
			{ 'Retry-After': String(Math.ceil((midnight - now) / 1000)) });
	}
	return denied();
}
