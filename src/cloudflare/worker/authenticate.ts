import { corsResponse } from './cors';
import { sha256Hex } from './auth';
import { parseOptionalString } from './utils';
import { CRATE_WEB_SESSION_NAME_HEADER } from '../../protocol/web-session';

type AuthScope = 'vault' | 'reminders';

export interface AuthPrincipal {
	tokenId: string;
	scope: AuthScope;
	folderPath?: string;
}

export type AuthenticationResult =
	| { principal: AuthPrincipal; response?: never }
	| { principal?: never; response: Response };

function readWebSessionName(request: Request): string | null {
	const encoded = parseOptionalString(request.headers.get(CRATE_WEB_SESSION_NAME_HEADER), 384);
	if (!encoded) return null;
	try {
		return parseOptionalString(decodeURIComponent(encoded), 128);
	} catch {
		return null;
	}
}

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
		// Refresh only this authenticated web session's display name. Older
		// clients omit the header, and vault-device names stay user-controlled.
		const sessionName = row.scope === 'reminders'
			? readWebSessionName(request)
			: null;
		await db.prepare(`UPDATE auth_tokens
			SET device_name = COALESCE(?, device_name), last_seen_at = datetime('now')
			WHERE id = ? AND ((? IS NOT NULL AND (device_name IS NULL OR device_name != ?))
				OR last_seen_at IS NULL OR last_seen_at < datetime('now', '-6 hours'))`)
			.bind(sessionName, row.id, sessionName, sessionName)
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
