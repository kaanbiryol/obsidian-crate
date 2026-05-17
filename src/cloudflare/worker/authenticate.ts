import { corsResponse } from './cors';
import { initDb } from './db';
import { sha256Hex, timingSafeEqual } from './auth';

export async function authenticateWorkerRequest(
	request: Request,
	db: D1Database | null,
	fallbackAuthToken: string,
): Promise<Response | null> {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return corsResponse({ error: 'Unauthorized' }, 401);
	}

	const token = authHeader.substring(7).trim();
	if (!token) {
		return corsResponse({ error: 'Unauthorized' }, 401);
	}

	let authenticated = false;
	if (db) {
		try {
			await initDb(db);
			const tokenHash = await sha256Hex(token);
			const row = await db.prepare('SELECT id FROM auth_tokens WHERE token_hash = ?').bind(tokenHash).first<{ id: string }>();
			if (row?.id) {
				authenticated = true;
				await db.prepare(`UPDATE auth_tokens
					SET last_seen_at = datetime('now')
					WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-6 hours'))`)
					.bind(row.id)
					.run();
			}
		} catch {
			// D1 failure falls through to binding token check.
		}
	}

	if (!authenticated && (!fallbackAuthToken || !await timingSafeEqual(token, fallbackAuthToken))) {
		return corsResponse({ error: 'Invalid token' }, 401);
	}

	return null;
}
