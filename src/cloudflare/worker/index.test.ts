import { describe, expect, it, vi } from 'vitest';
import worker from './index';
import { sha256Hex } from './auth';
import { PWA_ASSET_VERSION } from './pwa-version';
import { CRATE_SERVER_INFO } from './server-info';
import type { Env } from './types';

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
			if (typeof expiresAt !== 'number' || expiresAt <= now) {
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
			if (typeof expiresAt !== 'number' || expiresAt <= now) {
				return { meta: { changes: 0 } };
			}

			state.subscriptions.set(id, { id, endpoint });
			return { meta: { changes: 1 } };
		}

		if (sql.includes('DELETE FROM push_enrollment_tokens WHERE token_hash = ? AND expires_at > ?')) {
			const tokenHash = String(args[0]);
			const now = Number(args[1]);
			const expiresAt = state.tokens.get(tokenHash);
			if (typeof expiresAt !== 'number' || expiresAt <= now) {
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
				first: vi.fn(async () => sql.includes('SELECT id, scope FROM auth_tokens')
					? { id: 'vault-token', scope: 'vault' }
					: null),
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

function createEnv(overrides?: Partial<Env>): Env {
	return {
		...createEnvDefaults(),
		...overrides,
	};
}

function createEnvDefaults(): Env {
	return {
		BUCKET: {} as R2Bucket,
		DB: createDb({}).db as unknown as D1Database,
		REMINDER_ALARMS: {
			idFromName: vi.fn(),
			get: vi.fn(),
		} as unknown as DurableObjectNamespace,
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
	it('serves server metadata at the root without a public claim page', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/'),
			createEnv() as never,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/json');
		expect(await response.json()).toEqual(CRATE_SERVER_INFO);
	});

	it('does not expose the legacy public device enrollment routes', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/setup/status', {
				headers: { Authorization: 'Bearer secret-token' },
			}) as never,
			createEnv() as never,
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'Not found' });
	});

	it('does not let an authenticated device mint another vault credential', async () => {
		const enrollmentResponse = await worker.fetch(
			new Request('https://worker.test/auth/enrollment', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer secret-token',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ enrollmentTokenHash: 'a'.repeat(64) }),
			}),
			createEnv() as never,
		);
		const tokenResponse = await worker.fetch(
			new Request('https://worker.test/auth/tokens', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer secret-token',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ token_hash: 'a'.repeat(64) }),
			}),
			createEnv() as never,
		);

		expect(enrollmentResponse.status).toBe(404);
		expect(await enrollmentResponse.json()).toEqual({ error: 'Not found' });
		expect(tokenResponse.status).toBe(404);
		expect(await tokenResponse.json()).toEqual({ error: 'Not found' });
	});

	it('lets an authenticated device create a reminders web app enrollment token', async () => {
		const db = createDb({});
		const response = await worker.fetch(
			new Request('https://worker.test/notifications/reminders-enrollment-token', {
				method: 'POST',
				headers: { Authorization: 'Bearer secret-token' },
			}),
			createEnv({ DB: db.db as unknown as D1Database }) as never,
		);

		expect(response.status).toBe(200);
		const result = await response.json() as { token: string; expiresAt: string };
		expect(result.token).toHaveLength(64);
		expect(Number.isNaN(Date.parse(result.expiresAt))).toBe(false);
		expect(db.db.prepare).toHaveBeenCalledWith(
			'INSERT INTO web_enrollment_tokens (token_hash, expires_at) VALUES (?, ?)',
		);
	});

	it('publishes unauthenticated server compatibility metadata', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/.well-known/crate'),
			createEnv() as never,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(await response.json()).toEqual(CRATE_SERVER_INFO);
	});

	it('serves PWA version metadata without authentication', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/notifications/version.json'),
			createEnv() as never,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ assetVersion: PWA_ASSET_VERSION });
	});

	it('allows the service worker to control the exact notifications route', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/notifications/sw.js'),
			createEnv() as never,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Service-Worker-Allowed')).toBe('/notifications');
	});

	it('serves PWA scripts from same-origin assets under a strict CSP', async () => {
		const pageResponse = await worker.fetch(
			new Request('https://worker.test/notifications'),
			createEnv() as never,
		);
		const handoffResponse = await worker.fetch(
			new Request('https://worker.test/notifications/open-obsidian?project=Work'),
			createEnv() as never,
		);
		const themeScriptResponse = await worker.fetch(
			new Request(`https://worker.test/notifications/theme-bootstrap.js?v=${PWA_ASSET_VERSION}`),
			createEnv() as never,
		);
		const handoffScriptResponse = await worker.fetch(
			new Request(`https://worker.test/notifications/open-obsidian.js?v=${PWA_ASSET_VERSION}`),
			createEnv() as never,
		);

		expect(pageResponse.headers.get('Content-Security-Policy')).toContain("script-src 'self';");
		expect(pageResponse.headers.get('Content-Security-Policy')).not.toContain("script-src 'self' 'unsafe-inline'");
		expect(handoffResponse.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
		expect(await pageResponse.text()).not.toContain('<script>');
		expect(await handoffResponse.text()).not.toContain('<script>');
		expect(themeScriptResponse.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
		expect(handoffScriptResponse.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
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
		const staleVersionAppResponse = await worker.fetch(
			new Request('https://worker.test/notifications/app.js?v=stale'),
			createEnv() as never,
		);
		const versionedThemeResponse = await worker.fetch(
			new Request(`https://worker.test/notifications/theme-bootstrap.js?v=${PWA_ASSET_VERSION}`),
			createEnv() as never,
		);
		const versionedIconResponse = await worker.fetch(
			new Request(`https://worker.test/notifications/icon.svg?v=${PWA_ASSET_VERSION}`),
			createEnv() as never,
		);
		const versionedCrateIconResponse = await worker.fetch(
			new Request(`https://worker.test/notifications/crate-icon-512.png?v=${PWA_ASSET_VERSION}`),
			createEnv() as never,
		);
		const versionedTouchIconResponse = await worker.fetch(
			new Request(`https://worker.test/notifications/apple-touch-icon-180.png?v=${PWA_ASSET_VERSION}`),
			createEnv() as never,
		);
		const versionedStartupImageResponse = await worker.fetch(
			new Request(`https://worker.test/notifications/apple-startup-1206x2622.png?v=${PWA_ASSET_VERSION}`),
			createEnv() as never,
		);

		expect(versionedAppResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(unversionedAppResponse.headers.get('Cache-Control')).toBe('no-store');
		expect(staleVersionAppResponse.headers.get('Cache-Control')).toBe('no-store');
		expect(versionedThemeResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(versionedIconResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(versionedCrateIconResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(versionedCrateIconResponse.headers.get('Content-Type')).toBe('image/png');
		expect(versionedTouchIconResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(versionedTouchIconResponse.headers.get('Content-Type')).toBe('image/png');
		expect(versionedStartupImageResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(versionedStartupImageResponse.headers.get('Content-Type')).toBe('image/png');
		expect((await versionedStartupImageResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});

	it('rejects blank bearer tokens', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/health', {
				headers: { Authorization: 'Bearer ' },
			}),
			createEnv() as never,
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Unauthorized' });
	});

	it('returns a controlled 503 when authentication cannot reach D1', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/sync/manifest', {
				headers: { Authorization: 'Bearer secret-token' },
			}),
			createEnv({ DB: null as never }) as never,
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'Authentication service unavailable' });
	});

	it('returns a controlled 500 when a public route throws', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const response = await worker.fetch(
				new Request('https://worker.test/notifications/vapid-public-key'),
				createEnv({ DB: null as never }) as never,
			);

			expect(response.status).toBe(500);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(await response.json()).toEqual({ error: 'Internal server error' });
		} finally {
			consoleError.mockRestore();
		}
	});

	it('does not accept untracked file mutations when D1 is unavailable', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/sync/upload?path=notes/a.md', {
				method: 'PUT',
				headers: {
					Authorization: 'Bearer secret-token',
					'X-Crate-Expected-Hash': 'absent',
				},
				body: 'hello',
			}),
			createEnv({ DB: null as never }) as never,
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'Authentication service unavailable' });
	});

	it('accepts push subscription requests with a valid one-time enrollment token', async () => {
		const tokenHash = await sha256Hex('setup-token');
		const db = createDb({ [tokenHash]: Date.now() + 60_000 });
		const response = await worker.fetch(
			createSubscriptionRequest('setup-token'),
			createEnv({ DB: db.db as unknown as D1Database }) as never,
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
			createEnv({ DB: db.db as unknown as D1Database }) as never,
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
			createEnv({ DB: db.db as unknown as D1Database }) as never,
		);

		expect(firstResponse.status).toBe(500);
		expect(db.tokens.size).toBe(1);
		expect(db.subscriptions.size).toBe(0);

		db.setFailSubscriptionInsert(false);
		const retryResponse = await worker.fetch(
			createSubscriptionRequest('setup-token'),
			createEnv({ DB: db.db as unknown as D1Database }) as never,
		);

		expect(retryResponse.status).toBe(200);
		expect(db.tokens.size).toBe(0);
		expect(db.subscriptions.size).toBe(1);
	});

	it('removes a push subscription by endpoint during authenticated logout', async () => {
		const db = createDb({});
		db.subscriptions.set('subscription-id', {
			id: 'subscription-id',
			endpoint: 'https://push.example/subscription',
		});

		const response = await worker.fetch(
			new Request('https://worker.test/notifications/subscribe', {
				method: 'DELETE',
				headers: {
					Authorization: 'Bearer secret-token',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ endpoint: 'https://push.example/subscription' }),
			}),
			createEnv({ DB: db.db as unknown as D1Database }) as never,
		);

		expect(response.status).toBe(200);
		expect(db.subscriptions.size).toBe(0);
	});
});
