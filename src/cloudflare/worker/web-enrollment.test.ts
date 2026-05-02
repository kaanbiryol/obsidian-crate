import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './auth';
import { consumeWebEnrollmentToken, issueWebEnrollmentToken } from './web-enrollment';

function createDb(initialTokens?: Record<string, number>) {
	const tokens = new Map<string, number>(Object.entries(initialTokens ?? {}));

	const db = {
		prepare: vi.fn((sql: string) => {
			let boundArgs: unknown[] = [];
			const statement = {
				bind: vi.fn((...args: unknown[]) => {
					boundArgs = args;
					return statement;
				}),
				run: vi.fn(async () => {
					if (sql.includes('INSERT INTO web_enrollment_tokens')) {
						tokens.set(String(boundArgs[0]), Number(boundArgs[1]));
					}
					if (sql.includes('DELETE FROM web_enrollment_tokens WHERE token_hash = ?')) {
						tokens.delete(String(boundArgs[0]));
					}
					if (sql.includes('DELETE FROM web_enrollment_tokens WHERE expires_at <=')) {
						const cutoff = Number(boundArgs[0]);
						for (const [tokenHash, expiresAt] of tokens.entries()) {
							if (expiresAt <= cutoff) {
								tokens.delete(tokenHash);
							}
						}
					}
					return {};
				}),
				first: vi.fn(async () => {
					if (sql.includes('SELECT expires_at FROM web_enrollment_tokens WHERE token_hash = ?')) {
						const expiresAt = tokens.get(String(boundArgs[0]));
						return expiresAt === undefined ? null : { expires_at: expiresAt };
					}
					return null;
				}),
				all: vi.fn(async () => ({ results: [] })),
			};
			return statement;
		}),
		batch: vi.fn(async () => []),
		exec: vi.fn(async () => ({})),
	};

	return { db, tokens };
}

describe('web enrollment tokens', () => {
	it('issues short-lived tokens that are consumed once', async () => {
		const { db, tokens } = createDb();

		const issued = await issueWebEnrollmentToken(db as never);

		expect(issued.token).toHaveLength(64);
		expect(tokens.size).toBe(1);
		await expect(consumeWebEnrollmentToken(db as never, issued.token)).resolves.toBe(true);
		await expect(consumeWebEnrollmentToken(db as never, issued.token)).resolves.toBe(false);
		expect(tokens.size).toBe(0);
	});

	it('rejects expired tokens and purges them', async () => {
		const expiredToken = 'expired-web-token';
		const expiredHash = await sha256Hex(expiredToken);
		const { db, tokens } = createDb({
			[expiredHash]: Date.now() - 1000,
		});

		await expect(consumeWebEnrollmentToken(db as never, expiredToken)).resolves.toBe(false);
		expect(tokens.size).toBe(0);
	});
});
