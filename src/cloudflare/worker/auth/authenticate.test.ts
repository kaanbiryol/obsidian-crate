import { describe, expect, it, vi } from 'vitest';
import { authenticateWorkerRequest } from './authenticate';
import { CRATE_WEB_SESSION_NAME_HEADER } from '../../../protocol/web-session';
import { sha256Hex } from '../../../platform/sha256';

function createDb(tokenHash: string, row: { id: string; scope: string; folder_path?: string; device_name?: string; last_seen_stale?: number; feature_policy?: string } | null) {
	return {
		prepare: vi.fn((sql: string) => {
			const statement = {
				args: [] as unknown[],
				bind: vi.fn((...args: unknown[]) => {
					statement.args = args;
					return statement;
				}),
				first: vi.fn(async () => sql.includes('SELECT id, scope, folder_path,') && sql.includes('FROM auth_tokens')
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
		const db = createDb(await sha256Hex(token), { id: 'pwa-id', scope: 'reminders', folder_path: 'Reminders' });

		const result = await authenticateWorkerRequest(
			new Request('https://worker.test/reminders/list', {
				headers: { Authorization: `Bearer ${token}` },
			}),
			db as never,
		);

		expect(result).toEqual({ principal: { tokenId: 'pwa-id', scope: 'reminders', folderPath: 'Reminders' }, resetGeneration: null, featurePolicyValue: null });
		expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('expires_at > ?'));
	});

	it.each([
		['a recently seen device', { last_seen_stale: 0 }, undefined, 1],
		['a device last seen over 6 hours ago', { last_seen_stale: 1 }, undefined, 2],
		['a web session with an unchanged name', { last_seen_stale: 0, device_name: 'Phone' }, 'Phone', 1],
		['a renamed web session', { last_seen_stale: 0, device_name: 'Phone' }, 'Tablet', 2],
	])('sends the last-seen update only when it changes %s', async (_label, fields, sessionName, statements) => {
		const token = 'session-token';
		const db = createDb(await sha256Hex(token), { id: 'pwa-id', scope: 'reminders', folder_path: 'Reminders', ...fields });
		const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
		if (sessionName) headers[CRATE_WEB_SESSION_NAME_HEADER] = sessionName;

		await authenticateWorkerRequest(new Request('https://worker.test/reminders/list', { headers }), db as never);

		expect(db.prepare).toHaveBeenCalledTimes(statements);
	});

	it('returns the stored feature policy with the token', async () => {
		const token = 'vault-token';
		const policy = JSON.stringify({ reading: true, reminders: false, revision: 'r1' });
		const db = createDb(await sha256Hex(token), { id: 'vault-id', scope: 'vault', feature_policy: policy });

		const result = await authenticateWorkerRequest(new Request('https://worker.test/reminders/list', { headers: { Authorization: `Bearer ${token}` } }), db as never);

		expect(result).toMatchObject({ featurePolicyValue: policy });
		expect(db.prepare).toHaveBeenCalledTimes(1);
	});

	it('rejects database tokens that do not satisfy the expiry query', async () => {
		const token = 'expired-token';
		const db = createDb(await sha256Hex(token), null);

		const result = await authenticateWorkerRequest(
			new Request('https://worker.test/health', {
				headers: { Authorization: `Bearer ${token}` },
			}),
			db as never,
		);

		expect(result.response?.status).toBe(401);
	});

	it('rejects unknown token scopes instead of granting vault access', async () => {
		const token = 'unknown-scope-token';
		const db = createDb(await sha256Hex(token), { id: 'unknown-id', scope: 'admin' });

		const result = await authenticateWorkerRequest(
			new Request('https://worker.test/health', {
				headers: { Authorization: `Bearer ${token}` },
			}),
			db as never,
		);

		expect(result.response?.status).toBe(401);
		expect(db.prepare).toHaveBeenCalledTimes(1);
	});

	it('returns 503 instead of falling back when D1 authentication fails', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const result = await authenticateWorkerRequest(
			new Request('https://worker.test/health', {
				headers: { Authorization: 'Bearer device-token' },
			}),
			{ prepare: vi.fn(() => { throw new Error('D1 unavailable'); }) } as never,
		);

		expect(result.response?.status).toBe(503);
		consoleError.mockRestore();
	});
});
