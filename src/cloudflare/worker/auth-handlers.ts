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
	const deviceId = parsedBody.value.device_id === undefined
		? null
		: parseOptionalString(parsedBody.value.device_id, 128);
	if (parsedBody.value.device_id !== undefined && deviceId === null) {
		return corsResponse({ error: 'Invalid device_id' }, 400);
	}
	const platform = parsedBody.value.platform === undefined
		? null
		: parseOptionalString(parsedBody.value.platform, 32);
	if (parsedBody.value.platform !== undefined && platform === null) {
		return corsResponse({ error: 'Invalid platform' }, 400);
	}

	const existing = await db.prepare('SELECT id, device_id, device_name, platform, last_seen_at FROM auth_tokens WHERE token_hash = ?')
		.bind(tokenHash)
		.first<{ id: string; device_id: string | null; device_name: string | null; platform: string | null; last_seen_at: string | null }>();
	if (existing?.id) {
		const nextDeviceId = deviceId ?? existing.device_id;
		const nextDeviceName = deviceName ?? existing.device_name;
		const nextPlatform = platform ?? existing.platform;
		const shouldTouchSeen = deviceId !== null || existing.last_seen_at !== null;
		if (
			nextDeviceId !== existing.device_id
			|| nextDeviceName !== existing.device_name
			|| nextPlatform !== existing.platform
			|| (shouldTouchSeen && existing.last_seen_at === null)
		) {
			const statement = shouldTouchSeen
				? db.prepare(`UPDATE auth_tokens
					SET device_id = ?, device_name = ?, platform = ?, last_seen_at = datetime('now')
					WHERE id = ?`)
				: db.prepare(`UPDATE auth_tokens
					SET device_id = ?, device_name = ?, platform = ?
					WHERE id = ?`);
			await statement
				.bind(nextDeviceId, nextDeviceName, nextPlatform, existing.id)
				.run();
		}
		return corsResponse({ id: existing.id });
	}

	const id = crypto.randomUUID();
	const insertStatement = deviceId
		? db.prepare(`INSERT INTO auth_tokens
			(id, token_hash, device_id, device_name, platform, last_seen_at)
			VALUES (?, ?, ?, ?, ?, datetime('now'))`)
		: db.prepare(`INSERT INTO auth_tokens
			(id, token_hash, device_id, device_name, platform, last_seen_at)
			VALUES (?, ?, ?, ?, ?, NULL)`);
	await insertStatement.bind(id, tokenHash, deviceId, deviceName, platform).run();
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

export async function handleListTokens(request: Request, db: D1Database): Promise<Response> {
	await initDb(db);
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
