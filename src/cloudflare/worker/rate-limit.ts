import { sha256Hex } from './auth';
import { corsResponse } from './cors';
import { requestAdmissionKind } from './routes/admission';
import { admitLocally, authenticatedAdmissionKey } from './admission-state';

export interface NotificationRateLimiter { limit(input: { key: string }): Promise<{ success: boolean }> }
const actions = new Map([
  ['POST /reading/shortcut-pairing', 5], ['POST /reading/shortcut-exchange', 10],
  ['POST /notifications/share/reading', 30],
  ['POST /reading/exchange', 10], ['POST /reading/handoff', 30],
  ['POST /reading/prepare', 30], ['POST /reading/capture', 30],
  ['POST /reading/update', 60], ['POST /reading/retry', 10],
  ['POST /reading/access', 10], ['POST /reading/policy', 10], ['POST /features', 10], ['POST /reading/fetching', 10],
	['POST /notifications/reminders-exchange', 10],
	['POST /notifications/reminders-enrollment-token', 10],
	['POST /notifications/subscribe', 30],
	['DELETE /notifications/subscribe', 30],
	['POST /notifications/test', 3],
	['POST /notifications/retry', 10],
]);
const denied = () => corsResponse({ error: 'Too many requests. Try again in a minute.' }, 429, { 'Retry-After': '60' });

export async function limitNotificationRequest(request: Request, db: D1Database, limiter?: NotificationRateLimiter): Promise<Response | null> {
	const url = new URL(request.url);
	if (request.method === 'OPTIONS') return null;
	const kind = requestAdmissionKind(request);
	if (kind === 'asset') return null;
	if (kind === 'unknown') return corsResponse({ error: 'Not found' }, 404);
	const action = `${request.method} ${url.pathname}`;
	const authenticated = actions.has(action) ? undefined : await authenticatedAdmissionKey(request, db);
	// Sync bootstrap needs thousands of requests. A recently verified credential
	// gets a separate, bounded local budget; it still undergoes D1 authentication.
	// Unrecognized credentials cannot obtain this budget by rotating bearers.
	if (authenticated) return admitLocally(db, `authenticated:${authenticated}`, 6_000) ? null : denied();
	const address = await sha256Hex(request.headers.get('CF-Connecting-IP') ?? 'local');
	const key = `api-admission:${url.host}:${address}`;
	if (limiter) {
		// One sender cannot consume every user's edge admission slot. Invalid
		// credentials never reach the authenticated database-write budgets.
		if (!(await limiter.limit({ key })).success) return denied();
	} else {
		if (!admitLocally(db, key, 60)) return denied();
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
	const dailyKey = url.pathname.startsWith('/reading/') ? `reading-daily:${await sha256Hex(actor)}` : url.pathname === '/notifications/reminders-exchange' ? 'notification-exchange-daily' : 'notification-daily';
	const dailyLimit = url.pathname.startsWith('/reading/') ? 500 : 1000;
	const key = await sha256Hex(`${actor}\0${action}`);
	const results = await db.batch<{ results: Array<{ count: number }> }>([
		db.prepare(`INSERT INTO request_rate_limits (key, count, expires_at)
			SELECT ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM request_rate_limits WHERE key = ? AND expires_at > ? AND count >= ?)
			ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
				expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
			WHERE expires_at <= ? OR count < ${dailyLimit} RETURNING count`).bind(dailyKey, midnight, key, now, limit, now, now, now),
		db.prepare(`INSERT INTO request_rate_limits (key, count, expires_at)
			SELECT ?, 1, ? WHERE changes() = 1
			ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
				expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END`).bind(key, now + 60_000, now, now),
	]);
	if (results[0]?.results.length) return null;
	const daily = await db.prepare('SELECT count, expires_at FROM request_rate_limits WHERE key = ?').bind(dailyKey).first<{count: number; expires_at: number}>();
	if (daily && daily.expires_at > now && daily.count >= dailyLimit) {
		return corsResponse({ error: 'The daily notification request budget is exhausted. Try again tomorrow.' }, 429,
			{ 'Retry-After': String(Math.ceil((midnight - now) / 1000)) });
	}
	return denied();
}
