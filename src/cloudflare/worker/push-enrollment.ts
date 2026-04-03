import { sha256Hex } from './auth';
import { initDb } from './db';

const ENROLLMENT_TOKEN_TTL_MS = 10 * 60 * 1000;

function createEnrollmentToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function purgeExpiredPushEnrollmentTokens(db: D1Database): Promise<void> {
	try {
		await db.prepare('DELETE FROM push_enrollment_tokens WHERE expires_at <= ?')
			.bind(Date.now())
			.run();
	} catch {
		// Best effort cleanup.
	}
}

export async function issuePushEnrollmentToken(
	db: D1Database,
): Promise<{ token: string; expiresAt: number }> {
	await initDb(db);
	await purgeExpiredPushEnrollmentTokens(db);

	const token = createEnrollmentToken();
	const tokenHash = await sha256Hex(token);
	const expiresAt = Date.now() + ENROLLMENT_TOKEN_TTL_MS;

	await db.prepare('INSERT INTO push_enrollment_tokens (token_hash, expires_at) VALUES (?, ?)')
		.bind(tokenHash, expiresAt)
		.run();

	return { token, expiresAt };
}

export async function consumePushEnrollmentToken(
	db: D1Database,
	token: string,
): Promise<boolean> {
	await initDb(db);
	await purgeExpiredPushEnrollmentTokens(db);

	const trimmedToken = token.trim();
	if (!trimmedToken) {
		return false;
	}

	const tokenHash = await sha256Hex(trimmedToken);
	const row = await db.prepare('SELECT expires_at FROM push_enrollment_tokens WHERE token_hash = ?')
		.bind(tokenHash)
		.first<{ expires_at: number }>();

	if (!row) {
		return false;
	}

	await db.prepare('DELETE FROM push_enrollment_tokens WHERE token_hash = ?')
		.bind(tokenHash)
		.run();

	return Number.isFinite(row.expires_at) && row.expires_at > Date.now();
}
