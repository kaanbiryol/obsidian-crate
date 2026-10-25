import { sha256Hex } from '../../../platform/sha256';
import { createRandomHexToken } from '../../../platform/random-hex';

const WEB_ENROLLMENT_TOKEN_TTL_MS = 10 * 60 * 1000;

export async function issueWebEnrollmentToken(
	db: D1Database,
	folderPath = 'Reminders',
): Promise<{ token: string; expiresAt: number }> {
	// Maintenance deletes expired links; every redemption checks expiry itself.
	const token = createRandomHexToken();
	const tokenHash = await sha256Hex(token);
	const expiresAt = Date.now() + WEB_ENROLLMENT_TOKEN_TTL_MS;

	await db.prepare('INSERT INTO web_enrollment_tokens (token_hash, expires_at, folder_path) VALUES (?, ?, ?)')
		.bind(tokenHash, expiresAt, folderPath)
		.run();

	return { token, expiresAt };
}
