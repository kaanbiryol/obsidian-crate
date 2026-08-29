import { describe, expect, it, vi } from 'vitest';
import { issuePushEnrollmentToken, purgeExpiredPushEnrollmentTokens } from './push-enrollment';

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
					if (sql.includes('INSERT INTO push_enrollment_tokens')) {
						tokens.set(String(boundArgs[0]), Number(boundArgs[1]));
					}
					if (sql.includes('DELETE FROM push_enrollment_tokens WHERE token_hash = ?')) {
						tokens.delete(String(boundArgs[0]));
					}
					if (sql.includes('DELETE FROM push_enrollment_tokens WHERE expires_at <=')) {
						const cutoff = Number(boundArgs[0]);
						for (const [tokenHash, expiresAt] of tokens.entries()) {
							if (expiresAt <= cutoff) {
								tokens.delete(tokenHash);
							}
						}
					}
					return {};
				}),
				first: vi.fn(async () => null),
				all: vi.fn(async () => ({ results: [] })),
			};
			return statement;
		}),
		batch: vi.fn(async () => []),
		exec: vi.fn(async () => ({})),
	};

	return { db, tokens };
}

describe('push enrollment tokens', () => {
	it('issues a cryptographically random token and stores only its hash', async () => {
		const { db, tokens } = createDb();

		const issued = await issuePushEnrollmentToken(db as never);

		expect(issued.token).toHaveLength(64);
		expect(tokens.size).toBe(1);
		expect(tokens.has(issued.token)).toBe(false);
		expect(issued.expiresAt).toBeGreaterThan(Date.now());
	});

	it('purges expired tokens without removing live tokens', async () => {
		const liveHash = 'live-hash';
		const expiredHash = 'expired-hash';
		const { db, tokens } = createDb({
			[expiredHash]: Date.now() - 1000,
			[liveHash]: Date.now() + 1000,
		});

		await purgeExpiredPushEnrollmentTokens(db as never);

		expect(tokens.has(expiredHash)).toBe(false);
		expect(tokens.has(liveHash)).toBe(true);
	});
});
