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
					if (sql.includes('DELETE FROM web_enrollment_tokens') && sql.includes('RETURNING expires_at')) {
						const tokenHash = String(boundArgs[0]);
						const now = Number(boundArgs[1]);
						const expiresAt = tokens.get(tokenHash);
						if (expiresAt === undefined || expiresAt <= now) return null;
						tokens.delete(tokenHash);
						return { expires_at: expiresAt };
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

	it('allows only one concurrent exchange to consume a token', async () => {
		const issuedToken = 'concurrent-web-token';
		const tokenHash = await sha256Hex(issuedToken);
		const { db, tokens } = createDb({
			[tokenHash]: Date.now() + 60_000,
		});

		const results = await Promise.all([
			consumeWebEnrollmentToken(db as never, issuedToken),
			consumeWebEnrollmentToken(db as never, issuedToken),
		]);

		expect(results.filter(Boolean)).toHaveLength(1);
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
