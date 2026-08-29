import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './auth';
import { authenticateWorkerRequest } from './authenticate';

vi.mock('./db', () => ({
	initDb: vi.fn(async () => {}),
}));

function createDb(tokenHash: string, row: { id: string; scope: string } | null) {
	return {
		prepare: vi.fn((sql: string) => {
			const statement = {
				args: [] as unknown[],
				bind: vi.fn((...args: unknown[]) => {
					statement.args = args;
					return statement;
				}),
				first: vi.fn(async () => sql.includes('SELECT id, scope FROM auth_tokens')
					&& statement.args[0] === tokenHash
					? row
					: null),
				run: vi.fn(async () => ({})),
			};
			return statement;
		}),
	};
}

describe('worker authentication principals', () => {
	it('returns the stored scope for a non-expired database token', async () => {
		const token = 'pwa-session-token';
		const db = createDb(await sha256Hex(token), { id: 'pwa-id', scope: 'reminders' });

		const result = await authenticateWorkerRequest(
			new Request('https://worker.test/reminders/list', {
				headers: { Authorization: `Bearer ${token}` },
			}),
			db as never,
			'',
		);

		expect(result).toEqual({ principal: { tokenId: 'pwa-id', scope: 'reminders' } });
		expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('expires_at > ?'));
	});

	it('rejects database tokens that do not satisfy the expiry query', async () => {
		const token = 'expired-token';
		const db = createDb(await sha256Hex(token), null);

		const result = await authenticateWorkerRequest(
			new Request('https://worker.test/health', {
				headers: { Authorization: `Bearer ${token}` },
			}),
			db as never,
			'',
		);

		expect(result.response?.status).toBe(401);
	});

	it('treats the legacy binding token as a vault principal', async () => {
		const result = await authenticateWorkerRequest(
			new Request('https://worker.test/health', {
				headers: { Authorization: 'Bearer legacy-token' },
			}),
			null,
			'legacy-token',
		);

		expect(result).toEqual({ principal: { tokenId: null, scope: 'vault' } });
	});
});
