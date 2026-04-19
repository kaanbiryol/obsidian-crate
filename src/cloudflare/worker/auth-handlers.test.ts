import { describe, expect, it, vi } from 'vitest';
import { handleListTokens, handleRegisterToken } from './auth-handlers';

type TokenRecord = {
	id: string;
	token_hash: string;
	device_id: string | null;
	device_name: string | null;
	platform: string | null;
	created_at: string;
	last_seen_at: string | null;
};

function getBoundString(args: unknown[], index: number): string {
	const value = args[index];
	return typeof value === 'string' ? value : '';
}

function expectJsonWithId(value: unknown): void {
	expect(typeof value).toBe('object');
	expect(value).not.toBeNull();
	expect('id' in (value as Record<string, unknown>)).toBe(true);
	expect(typeof (value as Record<string, unknown>)['id']).toBe('string');
}

function createDb() {
	const tokens = new Map<string, TokenRecord>();

	const db = {
		prepare: vi.fn((sql: string) => {
			const statement = {
				_sql: sql,
				_args: [] as unknown[],
				bind: vi.fn((...args: unknown[]) => {
					statement._args = args;
					return statement;
				}),
					first: vi.fn(async () => {
						if (sql.includes('SELECT id, device_id, device_name, platform, last_seen_at FROM auth_tokens WHERE token_hash = ?')) {
							const tokenHash = getBoundString(statement._args, 0);
							const record = tokens.get(tokenHash);
						if (!record) {
							return null;
						}
						return {
							id: record.id,
							device_id: record.device_id,
							device_name: record.device_name,
							platform: record.platform,
							last_seen_at: record.last_seen_at,
						};
					}

						if (sql.includes('SELECT id FROM auth_tokens WHERE token_hash = ?')) {
							const tokenHash = getBoundString(statement._args, 0);
							const record = tokens.get(tokenHash);
						return record ? { id: record.id } : null;
					}

					return null;
				}),
				run: vi.fn(async () => {
					if (sql.startsWith('CREATE TABLE') || sql.startsWith('ALTER TABLE')) {
						return {};
					}

					if (sql.includes('INSERT INTO auth_tokens')) {
						const [id, tokenHash, deviceId, deviceName, platform] = statement._args;
						tokens.set(String(tokenHash), {
							id: String(id),
							token_hash: String(tokenHash),
							device_id: typeof deviceId === 'string' ? deviceId : null,
							device_name: typeof deviceName === 'string' ? deviceName : null,
							platform: typeof platform === 'string' ? platform : null,
							created_at: '2026-04-18 10:00:00',
							last_seen_at: sql.includes("datetime('now')") ? '2026-04-18 10:05:00' : null,
						});
					}

					if (sql.includes('UPDATE auth_tokens')) {
						const isSeenUpdate = sql.includes("last_seen_at = datetime('now')");
						const [deviceId, deviceName, platform, id] = statement._args;
						for (const record of tokens.values()) {
							if (record.id !== String(id)) {
								continue;
							}
							record.device_id = typeof deviceId === 'string' ? deviceId : null;
							record.device_name = typeof deviceName === 'string' ? deviceName : null;
							record.platform = typeof platform === 'string' ? platform : null;
							if (isSeenUpdate) {
								record.last_seen_at = '2026-04-18 11:00:00';
							}
						}
					}

					return {};
				}),
				all: vi.fn(async () => ({
					results: sql.includes('PRAGMA table_info(files)')
						? [{ name: 'path' }, { name: 'storage_key' }]
						: sql.includes('PRAGMA table_info(auth_tokens)')
							? [{ name: 'id' }, { name: 'token_hash' }, { name: 'device_id' }, { name: 'device_name' }, { name: 'platform' }, { name: 'last_seen_at' }]
							: sql.includes('SELECT id, device_id, device_name, platform, created_at, last_seen_at FROM auth_tokens')
								? Array.from(tokens.values())
								: [],
				})),
			};
			return statement;
		}),
	};

	return { db, tokens };
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

describe('auth token device metadata', () => {
	it('upgrades a setup-link token into a device record when the same token registers device metadata', async () => {
		const { db, tokens } = createDb();
		const tokenHash = await sha256Hex('token-1');

			const firstResponse = await handleRegisterToken(new Request('https://worker.test/auth/tokens', {
				method: 'POST',
				body: JSON.stringify({
					token_hash: tokenHash,
					device_name: 'setup-link',
				}),
			}), db as never);
			const firstBody: unknown = await firstResponse.json();
			expectJsonWithId(firstBody);
			expect(tokens.get(tokenHash)).toMatchObject({
				device_id: null,
				device_name: 'setup-link',
				last_seen_at: null,
			});

			const secondResponse = await handleRegisterToken(new Request('https://worker.test/auth/tokens', {
				method: 'POST',
				body: JSON.stringify({
					token_hash: tokenHash,
					device_id: 'device-abcd',
					device_name: 'Mac (abcd)',
					platform: 'macos',
				}),
			}), db as never);
			const secondBody: unknown = await secondResponse.json();
			expectJsonWithId(secondBody);
			expect(tokens.get(tokenHash)).toMatchObject({
				device_id: 'device-abcd',
				device_name: 'Mac (abcd)',
				platform: 'macos',
				last_seen_at: '2026-04-18 11:00:00',
			});
	});

	it('marks the active bearer token as the current device when listing tokens', async () => {
		const { db, tokens } = createDb();
		const currentHash = await sha256Hex('current-token');
		const otherHash = await sha256Hex('other-token');

		tokens.set(currentHash, {
			id: 'current-id',
			token_hash: currentHash,
			device_id: 'device-current',
			device_name: 'Mac (1234)',
			platform: 'macos',
			created_at: '2026-04-18 10:00:00',
			last_seen_at: '2026-04-18 12:00:00',
		});
		tokens.set(otherHash, {
			id: 'other-id',
			token_hash: otherHash,
			device_id: 'device-other',
			device_name: 'Android device (5678)',
			platform: 'android',
			created_at: '2026-04-17 10:00:00',
			last_seen_at: null,
		});

		const response = await handleListTokens(new Request('https://worker.test/auth/tokens', {
			headers: {
				Authorization: 'Bearer current-token',
			},
		}), db as never);
		expect(await response.json()).toEqual({
			tokens: [
				expect.objectContaining({
					id: 'current-id',
					is_current: true,
				}),
				expect.objectContaining({
					id: 'other-id',
					is_current: false,
				}),
			],
		});
	});
});
