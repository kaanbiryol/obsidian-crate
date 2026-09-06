import { parseFolderPath } from './reminders-web/requests';
import { createRandomHexToken, sha256Hex } from './auth';
import { corsResponse } from './cors';
import { getOrCreateVapidKeys } from './push';
import { parseJsonObject, parseOptionalString } from './utils';
import { consumeWebEnrollmentToken, issueWebEnrollmentToken } from './web-enrollment';

const REMINDERS_AUTH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export async function handleVapidPublicKey(db: D1Database): Promise<Response> {
	const keys = await getOrCreateVapidKeys(db);
	return corsResponse({ publicKey: keys.publicKey });
}

export async function handleCreateRemindersEnrollmentToken(db: D1Database, request: Request): Promise<Response> {
	const parsed = await parseJsonObject(request);
	if (!parsed.ok) return parsed.response;
	const folderPath = parseFolderPath(parsed.value.folderPath);
	if (!folderPath) return corsResponse({ error: 'folderPath required' }, 400);
	const installEnrollment = await issueWebEnrollmentToken(db, folderPath);
	const browserEnrollment = await issueWebEnrollmentToken(db, folderPath);
	return corsResponse({
		token: installEnrollment.token,
		browserToken: browserEnrollment.token,
		expiresAt: new Date(Math.min(installEnrollment.expiresAt, browserEnrollment.expiresAt)).toISOString(),
	});
}

export async function handleExchangeRemindersEnrollmentToken(
	request: Request,
	db: D1Database,
): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const token = parseOptionalString(parsedBody.value.token, 128);
	const deviceName = parseOptionalString(parsedBody.value.deviceName, 128) || 'Reminders web app';
	if (!token) {
		return corsResponse({ error: 'token required' }, 400);
	}

	const consumed = await consumeWebEnrollmentToken(db, token);
	if (!consumed) {
		return corsResponse({ error: 'Invalid or expired enrollment token' }, 401);
	}

	const authToken = createRandomHexToken();
	const tokenHash = await sha256Hex(authToken);
	const id = crypto.randomUUID();
	const expiresAt = Date.now() + REMINDERS_AUTH_TOKEN_TTL_MS;
	const previousToken = parseOptionalString(parsedBody.value.previousAuthToken, 128);
	const previousHash = previousToken ? await sha256Hex(previousToken) : null;

	await db.batch([db.prepare(`INSERT INTO auth_tokens
		(id, token_hash, device_id, device_name, platform, last_seen_at, scope, expires_at, folder_path)
		VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)`)
		.bind(id, tokenHash, null, deviceName, 'pwa', 'reminders', expiresAt, consumed),
		// Possession of the replaced reminder credential permits revocation even
		// after expiry. Remove its subscriptions so this browser can enroll again.
		...(previousHash ? [
			db.prepare("DELETE FROM push_subscriptions WHERE owner_token_id IN (SELECT id FROM auth_tokens WHERE token_hash = ? AND scope = 'reminders')").bind(previousHash),
			db.prepare("DELETE FROM auth_tokens WHERE token_hash = ? AND scope = 'reminders'").bind(previousHash),
		] : []),
	]);

	return corsResponse({ authToken, expiresAt: new Date(expiresAt).toISOString() });
}
