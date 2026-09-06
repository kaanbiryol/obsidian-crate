import { parseFolderPath } from './reminders-web/requests';
import { createRandomHexToken, sha256Hex } from './auth';
import { corsResponse } from './cors';
import { getOrCreateVapidKeys } from './push';
import { issuePushEnrollmentToken } from './push-enrollment';
import { parseJsonObject, parseOptionalString } from './utils';
import { consumeWebEnrollmentToken, issueWebEnrollmentToken } from './web-enrollment';

const REMINDERS_AUTH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export async function handleVapidPublicKey(db: D1Database): Promise<Response> {
	const keys = await getOrCreateVapidKeys(db);
	return corsResponse({ publicKey: keys.publicKey });
}

export async function handleCreateEnrollmentToken(db: D1Database): Promise<Response> {
	const { token, expiresAt } = await issuePushEnrollmentToken(db);
	return corsResponse({
		token,
		expiresAt: new Date(expiresAt).toISOString(),
	});
}

export async function handleCreateRemindersEnrollmentToken(db: D1Database, request?: Request): Promise<Response> {
	const parsed = request ? await parseJsonObject(request) : null;
	if (parsed && !parsed.ok) return parsed.response;
	const folderPath = parseFolderPath(parsed?.ok ? parsed.value.folderPath : null);
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

	await db.prepare(`INSERT INTO auth_tokens
		(id, token_hash, device_id, device_name, platform, last_seen_at, scope, expires_at, folder_path)
		VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)`)
		.bind(id, tokenHash, null, deviceName, 'pwa', 'reminders', expiresAt, consumed)
		.run();

	return corsResponse({ authToken, expiresAt: new Date(expiresAt).toISOString() });
}
