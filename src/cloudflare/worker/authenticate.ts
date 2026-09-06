import { corsResponse } from './cors';
import { sha256Hex } from './auth';

type AuthScope = 'vault' | 'reminders';

export interface AuthPrincipal {
	tokenId: string | null;
	scope: AuthScope;
	folderPath?: string;
}

export type AuthenticationResult =
	| { principal: AuthPrincipal; response?: never }
	| { principal?: never; response: Response };

export async function authenticateWorkerRequest(
	request: Request,
	db: D1Database,
): Promise<AuthenticationResult> {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return { response: corsResponse({ error: 'Unauthorized' }, 401) };
	}

	const token = authHeader.substring(7).trim();
	if (!token) {
		return { response: corsResponse({ error: 'Unauthorized' }, 401) };
	}

	try {
		const tokenHash = await sha256Hex(token);
		const row = await db.prepare(`SELECT id, scope, folder_path FROM auth_tokens
			WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)`)
			.bind(tokenHash, Date.now())
			.first<{ id: string; scope?: string | null; folder_path?: string | null }>();
		if (!row?.id) {
			return { response: corsResponse({ error: 'Invalid token' }, 401) };
		}
		if (row.scope !== 'vault' && row.scope !== 'reminders') {
			return { response: corsResponse({ error: 'Invalid token' }, 401) };
		}

		if (row.scope === 'reminders' && !row.folder_path) return { response: corsResponse({ error: 'Open a fresh Crate web app link to renew this session' }, 401) };
		await db.prepare(`UPDATE auth_tokens
			SET last_seen_at = datetime('now')
			WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-6 hours'))`)
			.bind(row.id)
			.run();
		return {
			principal: {
				tokenId: row.id,
				scope: row.scope,
				...(row.folder_path ? { folderPath: row.folder_path } : {}),
			},
		};
	} catch (error) {
		console.error('Worker authentication database unavailable', error);
		return { response: corsResponse({ error: 'Authentication service unavailable' }, 503) };
	}
}
