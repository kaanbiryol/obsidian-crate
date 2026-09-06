import { sha256Hex } from './auth';
import { corsResponse } from './cors';

/** Atomic fixed-window budget. Only hashes of network identifiers are stored. */
export async function limitNotificationRequest(request: Request, db: D1Database): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/notifications/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return null;
  const key = await sha256Hex(`${request.headers.get('CF-Connecting-IP') ?? 'local'}\0${path}`);
  const now = Date.now();
  const limit = path.endsWith('/test') ? 3 : path.includes('enrollment') ? 10 : 30;
  const row = await db.prepare(`INSERT INTO request_rate_limits (key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
    expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
    RETURNING count`).bind(key, now + 60_000, now, now).first<{ count: number }>();
  return row && row.count > limit ? corsResponse({ error: 'Too many notification requests. Try again in a minute.' }, 429, { 'Retry-After': '60' }) : null;
}
