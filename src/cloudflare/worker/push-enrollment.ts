import { createRandomHexToken, sha256Hex } from './auth';

const ENROLLMENT_TOKEN_TTL_MS = 10 * 60 * 1000;

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
	await purgeExpiredPushEnrollmentTokens(db);

	const token = createRandomHexToken();
	const tokenHash = await sha256Hex(token);
	const expiresAt = Date.now() + ENROLLMENT_TOKEN_TTL_MS;

	await db.prepare('INSERT INTO push_enrollment_tokens (token_hash, expires_at) VALUES (?, ?)')
		.bind(tokenHash, expiresAt)
		.run();

	return { token, expiresAt };
}
