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
	folderPath = 'Reminders',
): Promise<{ token: string; expiresAt: number }> {
	await purgeExpiredWebEnrollmentTokens(db);

	const token = createRandomHexToken();
	const tokenHash = await sha256Hex(token);
	const expiresAt = Date.now() + WEB_ENROLLMENT_TOKEN_TTL_MS;

	await db.prepare('INSERT INTO web_enrollment_tokens (token_hash, expires_at, folder_path) VALUES (?, ?, ?)')
		.bind(tokenHash, expiresAt, folderPath)
		.run();

	return { token, expiresAt };
}

export async function consumeWebEnrollmentToken(
	db: D1Database,
	token: string,
): Promise<string | null> {
	await purgeExpiredWebEnrollmentTokens(db);

	const trimmedToken = token.trim();
	if (!trimmedToken) {
		return null;
	}

	const tokenHash = await sha256Hex(trimmedToken);
	const row = await db.prepare(`DELETE FROM web_enrollment_tokens
		WHERE token_hash = ? AND expires_at > ?
		RETURNING expires_at, folder_path`)
		.bind(tokenHash, Date.now())
		.first<{ expires_at: number; folder_path: string | null }>();

	return row && Number.isFinite(row.expires_at) ? row.folder_path : null;
}
