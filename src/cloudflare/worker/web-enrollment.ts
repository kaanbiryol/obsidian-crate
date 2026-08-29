import { createRandomHexToken, sha256Hex } from './auth';

const WEB_ENROLLMENT_TOKEN_TTL_MS = 10 * 60 * 1000;

async function purgeExpiredWebEnrollmentTokens(db: D1Database): Promise<void> {
	try {
		await db.prepare('DELETE FROM web_enrollment_tokens WHERE expires_at <= ?')
			.bind(Date.now())
			.run();
	} catch {
		// Best effort cleanup.
	}
}

export async function issueWebEnrollmentToken(
	db: D1Database,
): Promise<{ token: string; expiresAt: number }> {
	await purgeExpiredWebEnrollmentTokens(db);

	const token = createRandomHexToken();
	const tokenHash = await sha256Hex(token);
	const expiresAt = Date.now() + WEB_ENROLLMENT_TOKEN_TTL_MS;

	await db.prepare('INSERT INTO web_enrollment_tokens (token_hash, expires_at) VALUES (?, ?)')
		.bind(tokenHash, expiresAt)
		.run();

	return { token, expiresAt };
}

export async function consumeWebEnrollmentToken(
	db: D1Database,
	token: string,
): Promise<boolean> {
	await purgeExpiredWebEnrollmentTokens(db);

	const trimmedToken = token.trim();
	if (!trimmedToken) {
		return false;
	}

	const tokenHash = await sha256Hex(trimmedToken);
	const row = await db.prepare(`DELETE FROM web_enrollment_tokens
		WHERE token_hash = ? AND expires_at > ?
		RETURNING expires_at`)
		.bind(tokenHash, Date.now())
		.first<{ expires_at: number }>();

	return row !== null && Number.isFinite(row.expires_at);
}
