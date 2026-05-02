import { describe, expect, it, vi } from 'vitest';
import worker from './index';
import { sha256Hex } from './auth';
import { PWA_ASSET_VERSION } from './pwa-version.gen';

interface SubscriptionRecord {
	id: string;
	endpoint: string;
}

function createDb(initialTokens: Record<string, number>, options?: { failSubscriptionInsert?: boolean }) {
	let tokens = new Map<string, number>(Object.entries(initialTokens));
	let subscriptions = new Map<string, SubscriptionRecord>();
	let failSubscriptionInsert = options?.failSubscriptionInsert ?? false;

	const applyMutation = (state: { tokens: Map<string, number>; subscriptions: Map<string, SubscriptionRecord> }, sql: string, args: unknown[]) => {
		if (sql.startsWith('CREATE TABLE')) {
			return { meta: { changes: 0 } };
		}

		if (sql.includes('DELETE FROM push_enrollment_tokens WHERE expires_at <= ?')) {
			const cutoff = Number(args[0]);
			let changes = 0;
			for (const [tokenHash, expiresAt] of state.tokens.entries()) {
				if (expiresAt <= cutoff) {
					state.tokens.delete(tokenHash);
					changes += 1;
				}
			}
			return { meta: { changes } };
		}

		if (sql.includes('DELETE FROM push_subscriptions WHERE endpoint = ? AND EXISTS')) {
			const endpoint = String(args[0]);
			const tokenHash = String(args[1]);
			const now = Number(args[2]);
			const expiresAt = state.tokens.get(tokenHash);
			if (!Number.isFinite(expiresAt) || expiresAt <= now) {
				return { meta: { changes: 0 } };
			}

			let changes = 0;
			for (const [id, subscription] of state.subscriptions.entries()) {
				if (subscription.endpoint === endpoint) {
					state.subscriptions.delete(id);
					changes += 1;
				}
			}
			return { meta: { changes } };
		}

		if (sql.includes('INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_name) SELECT')) {
			if (failSubscriptionInsert) {
				throw new Error('subscription insert failed');
			}

			const id = String(args[0]);
			const endpoint = String(args[1]);
			const tokenHash = String(args[5]);
			const now = Number(args[6]);
			const expiresAt = state.tokens.get(tokenHash);
			if (!Number.isFinite(expiresAt) || expiresAt <= now) {
				return { meta: { changes: 0 } };
			}

			state.subscriptions.set(id, { id, endpoint });
			return { meta: { changes: 1 } };
		}

		if (sql.includes('DELETE FROM push_enrollment_tokens WHERE token_hash = ? AND expires_at > ?')) {
			const tokenHash = String(args[0]);
			const now = Number(args[1]);
			const expiresAt = state.tokens.get(tokenHash);
			if (!Number.isFinite(expiresAt) || expiresAt <= now) {
				return { meta: { changes: 0 } };
			}

			state.tokens.delete(tokenHash);
			return { meta: { changes: 1 } };
		}

		if (sql.includes('DELETE FROM push_subscriptions WHERE endpoint = ?')) {
			const endpoint = String(args[0]);
			let changes = 0;
			for (const [id, subscription] of state.subscriptions.entries()) {
				if (subscription.endpoint === endpoint) {
					state.subscriptions.delete(id);
					changes += 1;
				}
			}
			return { meta: { changes } };
		}

		if (sql.includes('INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_name) VALUES')) {
			if (failSubscriptionInsert) {
				throw new Error('subscription insert failed');
			}

			const id = String(args[0]);
			const endpoint = String(args[1]);
			state.subscriptions.set(id, { id, endpoint });
			return { meta: { changes: 1 } };
		}

		return { meta: { changes: 0 } };
	};

	const db = {
		prepare: vi.fn((sql: string) => {
			const statement = {
				_sql: sql,
				_args: [] as unknown[],
				bind: vi.fn((...args: unknown[]) => {
					statement._args = args;
					return statement;
				}),
				first: vi.fn(async () => null),
				run: vi.fn(async () => applyMutation({ tokens, subscriptions }, sql, statement._args)),
				all: vi.fn(async () => ({ results: [] })),
			};
			return statement;
		}),
		batch: vi.fn(async (statements: Array<{ _sql: string; _args: unknown[] }>) => {
			const nextTokens = new Map(tokens);
			const nextSubscriptions = new Map(subscriptions);
			const nextState = {
				tokens: nextTokens,
				subscriptions: nextSubscriptions,
			};
			const results: Array<{ meta: { changes: number } }> = [];

			for (const statement of statements) {
				results.push(applyMutation(nextState, statement._sql, statement._args));
			}

			tokens = nextTokens;
			subscriptions = nextSubscriptions;
			return results;
		}),
		exec: vi.fn(async () => ({})),
	};

	return {
		db,
		get tokens() {
			return tokens;
		},
		get subscriptions() {
			return subscriptions;
		},
		setFailSubscriptionInsert(value: boolean) {
			failSubscriptionInsert = value;
		},
	};
}

function createEnv(overrides?: Partial<ReturnType<typeof createEnvDefaults>>) {
	return {
		...createEnvDefaults(),
		...overrides,
	};
}

function createEnvDefaults() {
	return {
		BUCKET: {},
		DB: null,
		AUTH_TOKEN: 'secret-token',
		CF_ACCOUNT_ID: '',
		CF_WORKER_NAME: '',
		CF_BUCKET_NAME: '',
		CF_DATABASE_ID: '',
		REMINDER_ALARMS: {
			idFromName: vi.fn(),
			get: vi.fn(),
		},
	};
}

function createSubscriptionRequest(token: string): Request {
	return new Request('https://worker.test/notifications/subscribe', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Crate-Enrollment-Token': token,
		},
		body: JSON.stringify({
			endpoint: 'https://push.example/subscription',
			keys: {
				p256dh: 'p256dh-key',
				auth: 'auth-key',
			},
		}),
	});
}

describe('worker entrypoint', () => {
	it('serves PWA version metadata without authentication', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/notifications/version.json'),
			createEnv() as never,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ assetVersion: PWA_ASSET_VERSION });
	});

	it('uses immutable caching for versioned PWA app assets only', async () => {
		const versionedAppResponse = await worker.fetch(
			new Request(`https://worker.test/notifications/app.js?v=${PWA_ASSET_VERSION}`),
			createEnv() as never,
		);
		const unversionedAppResponse = await worker.fetch(
			new Request('https://worker.test/notifications/app.js'),
			createEnv() as never,
		);
		const versionedIconResponse = await worker.fetch(
			new Request(`https://worker.test/notifications/icon.svg?v=${PWA_ASSET_VERSION}`),
			createEnv() as never,
		);

		expect(versionedAppResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(unversionedAppResponse.headers.get('Cache-Control')).toBe('no-store');
		expect(versionedIconResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
	});

	it('rejects blank bearer tokens when no fallback auth token is configured', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/health', {
				headers: { Authorization: 'Bearer ' },
			}),
			createEnv({ AUTH_TOKEN: '' }) as never,
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Unauthorized' });
	});

	it('returns a controlled 503 when a DB-backed sync route is requested without D1', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/sync/manifest', {
				headers: { Authorization: 'Bearer secret-token' },
			}),
			createEnv() as never,
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'Database not available' });
	});

	it('accepts push subscription requests with a valid one-time enrollment token', async () => {
		const tokenHash = await sha256Hex('setup-token');
		const db = createDb({ [tokenHash]: Date.now() + 60_000 });
		const response = await worker.fetch(
			createSubscriptionRequest('setup-token'),
			createEnv({ DB: db.db }) as never,
		);

		expect(response.status).toBe(200);
		expect(db.db.batch).toHaveBeenCalledTimes(1);
		expect(db.tokens.size).toBe(0);
		expect(db.subscriptions.size).toBe(1);
	});

	it('rejects expired enrollment tokens before subscribing devices', async () => {
		const tokenHash = await sha256Hex('expired-token');
		const db = createDb({ [tokenHash]: Date.now() - 1000 });
		const response = await worker.fetch(
			createSubscriptionRequest('expired-token'),
			createEnv({ DB: db.db }) as never,
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Invalid or expired enrollment token' });
		expect(db.subscriptions.size).toBe(0);
	});

	it('keeps the enrollment token available when the subscription insert fails', async () => {
		const tokenHash = await sha256Hex('setup-token');
		const db = createDb({ [tokenHash]: Date.now() + 60_000 }, { failSubscriptionInsert: true });

		const firstResponse = await worker.fetch(
			createSubscriptionRequest('setup-token'),
			createEnv({ DB: db.db }) as never,
		);

		expect(firstResponse.status).toBe(500);
		expect(db.tokens.size).toBe(1);
		expect(db.subscriptions.size).toBe(0);

		db.setFailSubscriptionInsert(false);
		const retryResponse = await worker.fetch(
			createSubscriptionRequest('setup-token'),
			createEnv({ DB: db.db }) as never,
		);

		expect(retryResponse.status).toBe(200);
		expect(db.tokens.size).toBe(0);
		expect(db.subscriptions.size).toBe(1);
	});
});
