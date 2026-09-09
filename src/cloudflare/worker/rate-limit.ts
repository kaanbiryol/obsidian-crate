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
		// A fixed key bounds D1 traffic even when attackers rotate addresses.
		if (!(await limiter.limit({ key: `notification-writes:${url.host}` })).success) return denied();
	} else {
		let budget = fallback.get(db);
		if (!budget || budget.expires <= now) { budget = { expires: now + 60_000, count: 0 }; fallback.set(db, budget); }
		if (++budget.count > 60) return denied();
	}
	// Location-scoped edge counters alone cannot bound global daily D1 writes.
	// This fixed row admits at most 1,000 attempts per UTC day across all IPs
	// and locations; denied attempts read one row and never increment it.
	const midnight = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
	const admitted = await db.prepare(`INSERT INTO request_rate_limits (key, count, expires_at) VALUES ('notification-daily', 1, ?)
		ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
		expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
		WHERE expires_at <= ? OR count < 1000 RETURNING count`).bind(midnight, now, now, now).first<{ count: number }>();
	if (!admitted) return corsResponse({ error: 'The daily notification request budget is exhausted. Try again tomorrow.' }, 429, { 'Retry-After': String(Math.ceil((midnight - now) / 1000)) });
	const key = await sha256Hex(`${request.headers.get('CF-Connecting-IP') ?? 'local'}\0${action}`);
	const row = await db.prepare(`INSERT INTO request_rate_limits (key, count, expires_at) VALUES (?, 1, ?)
		ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
		expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
		WHERE expires_at <= ? OR count < ? RETURNING count`).bind(key, now + 60_000, now, now, now, limit).first<{ count: number }>();
	return row ? null : denied();
}
