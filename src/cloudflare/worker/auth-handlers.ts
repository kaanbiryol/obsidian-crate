import { corsResponse } from './cors';
import { initDb, queryRows } from './db';

export async function handleRegisterToken(request: Request, db: D1Database): Promise<Response> {
	await initDb(db);
	const body = await request.json() as { token_hash?: string; device_name?: string };
	if (!body.token_hash || typeof body.token_hash !== 'string') {
		return corsResponse({ error: 'token_hash required' }, 400);
	}
	const id = crypto.randomUUID();
	await db.prepare('INSERT INTO auth_tokens (id, token_hash, device_name) VALUES (?, ?, ?)')
		.bind(id, body.token_hash, body.device_name || null).run();
	return corsResponse({ id });
}

export async function handleRevokeToken(request: Request, db: D1Database): Promise<Response> {
	await initDb(db);
	const body = await request.json() as { id?: string };
	if (!body.id || typeof body.id !== 'string') {
		return corsResponse({ error: 'id required' }, 400);
	}
	await db.prepare('DELETE FROM auth_tokens WHERE id = ?').bind(body.id).run();
	return corsResponse({ success: true });
}

export async function handleListTokens(db: D1Database): Promise<Response> {
	await initDb(db);
	const rows = await queryRows(db.prepare('SELECT id, device_name, created_at FROM auth_tokens ORDER BY created_at DESC'));
	return corsResponse({ tokens: rows });
}
