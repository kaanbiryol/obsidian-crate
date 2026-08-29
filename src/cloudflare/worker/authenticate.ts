import { corsResponse } from './cors';
import { initDb } from './db';
import { sha256Hex, timingSafeEqual } from './auth';

type AuthScope = 'vault' | 'reminders';

export interface AuthPrincipal {
	tokenId: string | null;
	scope: AuthScope;
}

export type AuthenticationResult =
	| { principal: AuthPrincipal; response?: never }
	| { principal?: never; response: Response };

export async function authenticateWorkerRequest(
	request: Request,
	db: D1Database | null,
	fallbackAuthToken: string,
): Promise<AuthenticationResult> {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return { response: corsResponse({ error: 'Unauthorized' }, 401) };
	}

	const token = authHeader.substring(7).trim();
	if (!token) {
		return { response: corsResponse({ error: 'Unauthorized' }, 401) };
	}

	if (db) {
		try {
			await initDb(db);
			const tokenHash = await sha256Hex(token);
			const row = await db.prepare(`SELECT id, scope FROM auth_tokens
				WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)`)
				.bind(tokenHash, Date.now())
				.first<{ id: string; scope?: string | null }>();
			if (row?.id) {
				await db.prepare(`UPDATE auth_tokens
					SET last_seen_at = datetime('now')
					WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-6 hours'))`)
					.bind(row.id)
					.run();
				return {
					principal: {
						tokenId: row.id,
						scope: row.scope === 'reminders' ? 'reminders' : 'vault',
					},
				};
			}
		} catch {
			// D1 failure falls through to binding token check.
		}
	}

	if (!fallbackAuthToken || !await timingSafeEqual(token, fallbackAuthToken)) {
		return { response: corsResponse({ error: 'Invalid token' }, 401) };
	}

	return { principal: { tokenId: null, scope: 'vault' } };
}
