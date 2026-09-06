import { corsResponse } from './cors';
import { sha256Hex } from './auth';
import { queryRows } from './db';
import { parseJsonObject, parseOptionalString } from './utils';

export async function handleRevokeToken(request: Request, db: D1Database): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id) {
		return corsResponse({ error: 'id required' }, 400);
	}
	await db.batch([db.prepare('DELETE FROM push_subscriptions WHERE owner_token_id = ?').bind(id), db.prepare('DELETE FROM auth_tokens WHERE id = ?').bind(id)]);
	return corsResponse({ success: true });
}

export async function handleRevokeCurrentToken(request: Request, db: D1Database): Promise<Response> {
	const authHeader = request.headers.get('Authorization') || '';
	const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';
	if (!token) {
		return corsResponse({ error: 'Unauthorized' }, 401);
	}

	const tokenHash = await sha256Hex(token);
	await db.batch([db.prepare('DELETE FROM push_subscriptions WHERE owner_token_id IN (SELECT id FROM auth_tokens WHERE token_hash = ?)').bind(tokenHash), db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').bind(tokenHash)]);
	return corsResponse({ success: true });
}

export async function handleListTokens(request: Request, db: D1Database): Promise<Response> {
	const authHeader = request.headers.get('Authorization') || '';
	const currentToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';
	const currentTokenHash = currentToken
		? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(currentToken)).then((hash) =>
			Array.from(new Uint8Array(hash)).map((value) => value.toString(16).padStart(2, '0')).join(''))
		: '';
	const currentTokenRow = currentTokenHash
		? await db.prepare('SELECT id FROM auth_tokens WHERE token_hash = ?').bind(currentTokenHash).first<{ id: string }>()
		: null;
	const rows = await queryRows<{
		id: string;
		device_id: string | null;
		device_name: string | null;
		platform: string | null;
		created_at: string;
		last_seen_at: string | null;
	}>(db.prepare('SELECT id, device_id, device_name, platform, created_at, last_seen_at FROM auth_tokens ORDER BY COALESCE(last_seen_at, created_at) DESC, created_at DESC'));
	const tokens = rows.map((row) => ({
		...row,
		is_current: row.id === currentTokenRow?.id,
	}));
	return corsResponse({ tokens });
}
