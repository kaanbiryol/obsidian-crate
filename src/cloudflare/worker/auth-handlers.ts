import { corsResponse } from './cors';
import { initDb, queryRows } from './db';
import { isSha256Hex, parseJsonObject, parseOptionalString } from './utils';

export async function handleRegisterToken(request: Request, db: D1Database): Promise<Response> {
	await initDb(db);
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const tokenHash = parseOptionalString(parsedBody.value.token_hash, 64)?.toLowerCase() || '';
	if (!isSha256Hex(tokenHash)) {
		return corsResponse({ error: 'token_hash required' }, 400);
	}

	const deviceName = parsedBody.value.device_name === undefined
		? null
		: parseOptionalString(parsedBody.value.device_name, 128);
	if (parsedBody.value.device_name !== undefined && deviceName === null) {
		return corsResponse({ error: 'Invalid device_name' }, 400);
	}

	const existing = await db.prepare('SELECT id FROM auth_tokens WHERE token_hash = ?')
		.bind(tokenHash)
		.first<{ id: string }>();
	if (existing?.id) {
		return corsResponse({ id: existing.id });
	}

	const id = crypto.randomUUID();
	await db.prepare('INSERT INTO auth_tokens (id, token_hash, device_name) VALUES (?, ?, ?)')
		.bind(id, tokenHash, deviceName).run();
	return corsResponse({ id });
}

export async function handleRevokeToken(request: Request, db: D1Database): Promise<Response> {
	await initDb(db);
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id) {
		return corsResponse({ error: 'id required' }, 400);
	}
	await db.prepare('DELETE FROM auth_tokens WHERE id = ?').bind(id).run();
	return corsResponse({ success: true });
}

export async function handleListTokens(db: D1Database): Promise<Response> {
	await initDb(db);
	const rows = await queryRows(db.prepare('SELECT id, device_name, created_at FROM auth_tokens ORDER BY created_at DESC'));
	return corsResponse({ tokens: rows });
}
