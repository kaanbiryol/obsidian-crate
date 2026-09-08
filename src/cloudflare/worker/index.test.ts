import { CRATE_PLUGIN_PROTOCOL } from '@/protocol';
import { describe, expect, it, vi } from 'vitest';
import worker from './index';
import { PWA_ASSET_VERSION } from './pwa-version';
import { CRATE_SERVER_INFO } from './server-info';
import type { Env } from './types';

interface SubscriptionRecord {
	id: string;
	endpoint: string;
}

function createDb(
	options?: { failSubscriptionInsert?: boolean; authenticatedScope?: 'vault' | 'reminders' },
) {
	let subscriptions = new Map<string, SubscriptionRecord>();
	let failSubscriptionInsert = options?.failSubscriptionInsert ?? false;

	const applyMutation = (state: { subscriptions: Map<string, SubscriptionRecord> }, sql: string, args: unknown[]) => {
		if (sql.startsWith('CREATE TABLE')) {
			return { meta: { changes: 0 } };
		}
    if (sql.includes('INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_name, owner_token_id, folder_path)')) {
      if (failSubscriptionInsert) throw new Error('subscription insert failed');
      const endpoint = String(args[1]);
      const id = [...state.subscriptions.values()].find(row => row.endpoint === endpoint)?.id ?? String(args[0]);
      state.subscriptions.set(id, { id, endpoint });
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
				first: vi.fn(async () => sql.includes('SELECT id, scope, folder_path FROM auth_tokens')
					? { id: 'authenticated-token', scope: options?.authenticatedScope ?? 'vault', folder_path: 'Reminders' }
					: sql.startsWith('SELECT id FROM push_subscriptions WHERE endpoint = ?')
						? [...subscriptions.values()].find(row => row.endpoint === statement._args[0]) ?? null
					: null),
				run: vi.fn(async () => applyMutation({ subscriptions }, sql, statement._args)),
				all: vi.fn(async () => ({ results: [] })),
			};
			return statement;
		}),
		batch: vi.fn(async (statements: Array<{ _sql: string; _args: unknown[] }>) => {
			const nextSubscriptions = new Map(subscriptions);
			const nextState = {
				subscriptions: nextSubscriptions,
			};
			const results: Array<{ meta: { changes: number } }> = [];

			for (const statement of statements) {
				results.push(applyMutation(nextState, statement._sql, statement._args));
			}

			subscriptions = nextSubscriptions;
			return results;
		}),
		exec: vi.fn(async () => ({})),
	};

	return {
		db,
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
		DB: createDb().db as unknown as D1Database,
		REMINDER_ALARMS: {
			idFromName: vi.fn(),
			get: vi.fn(),
		} as unknown as DurableObjectNamespace,
	};
}

function createSubscriptionRequest(): Request {
	return new Request('https://worker.test/notifications/subscribe', {
		method: 'POST',
		headers: { 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
			'Content-Type': 'application/json',
			Authorization: 'Bearer device-token',
		},
		body: JSON.stringify({
			endpoint: 'https://fcm.googleapis.com/subscription',
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
		expect(await response.json()).toEqual({ ...CRATE_SERVER_INFO, reminderOperationDay: Math.floor(Date.now() / 86_400_000) });
	});

	it('does not expose the public device enrollment routes', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/setup/status', {
				headers: { 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), Authorization: 'Bearer secret-token' },
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
				headers: { 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
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
				headers: { 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
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
		const db = createDb();
		const response = await worker.fetch(
			new Request('https://worker.test/notifications/reminders-enrollment-token', {
				method: 'POST',
				headers: { 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), Authorization: 'Bearer secret-token' },
        body: JSON.stringify({ folderPath: 'Reminders' }),
			}),
			createEnv({ DB: db.db as unknown as D1Database }) as never,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		const result = await response.json() as { token: string; browserToken: string; expiresAt: string };
		expect(result.token).toHaveLength(64);
		expect(result.browserToken).toHaveLength(64);
		expect(result.browserToken).not.toBe(result.token);
		expect(Number.isNaN(Date.parse(result.expiresAt))).toBe(false);
		expect(db.db.prepare).toHaveBeenCalledWith(
			'INSERT INTO web_enrollment_tokens (token_hash, expires_at, folder_path) VALUES (?, ?, ?)',
		);
	});

	it('prevents a reminders session from minting a replacement session', async () => {
		const db = createDb({ authenticatedScope: 'reminders' });
		const response = await worker.fetch(
			new Request('https://worker.test/notifications/reminders-enrollment-token', {
				method: 'POST',
				headers: { 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), Authorization: 'Bearer reminders-token' },
			}),
			createEnv({ DB: db.db as unknown as D1Database }) as never,
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: 'Token is not authorized for this operation' });
		expect(db.db.prepare).not.toHaveBeenCalledWith(
			'INSERT INTO web_enrollment_tokens (token_hash, expires_at, folder_path) VALUES (?, ?, ?)',
		);
	});

	it('publishes unauthenticated server compatibility metadata', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/.well-known/crate'),
			createEnv() as never,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(await response.json()).toEqual({ ...CRATE_SERVER_INFO, reminderOperationDay: Math.floor(Date.now() / 86_400_000) });
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

		expect(versionedAppResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(unversionedAppResponse.headers.get('Cache-Control')).toBe('no-store');
		expect(staleVersionAppResponse.headers.get('Cache-Control')).toBe('no-store');
		expect(versionedThemeResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(versionedIconResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(versionedCrateIconResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(versionedCrateIconResponse.headers.get('Content-Type')).toBe('image/png');
		expect(versionedTouchIconResponse.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(versionedTouchIconResponse.headers.get('Content-Type')).toBe('image/png');
	});

	it('rejects blank bearer tokens', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/health', {
				headers: { 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), Authorization: 'Bearer ' },
			}),
			createEnv() as never,
		);

		expect(response.status).toBe(401);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(await response.json()).toEqual({ error: 'Unauthorized' });
	});

	it('returns a controlled 503 when authentication cannot reach D1', async () => {
		const response = await worker.fetch(
			new Request('https://worker.test/sync/manifest', {
				headers: { 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), Authorization: 'Bearer secret-token' },
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
				headers: { 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
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

	it('requires an authenticated session to subscribe', async () => {
		const request = createSubscriptionRequest();
		request.headers.delete('Authorization');
		const response = await worker.fetch(request, createEnv() as never);
		expect(response.status).toBe(401);
	});

	it('registers a push subscription owned by the authenticated session', async () => {
		const db = createDb({ authenticatedScope: 'reminders' });
		const response = await worker.fetch(createSubscriptionRequest(), createEnv({ DB: db.db as unknown as D1Database }) as never);
		expect(response.status).toBe(200);
		expect(db.subscriptions.size).toBe(1);
	});

	it('allows retrying a failed authenticated subscription insert', async () => {
		const db = createDb({ failSubscriptionInsert: true });
		const env = createEnv({ DB: db.db as unknown as D1Database });
		expect((await worker.fetch(createSubscriptionRequest(), env as never)).status).toBe(500);
		expect(db.subscriptions.size).toBe(0);
		db.setFailSubscriptionInsert(false);
		expect((await worker.fetch(createSubscriptionRequest(), env as never)).status).toBe(200);
		expect(db.subscriptions.size).toBe(1);
	});

	it('removes a push subscription by endpoint during authenticated logout', async () => {
		const db = createDb();
		db.subscriptions.set('subscription-id', {
			id: 'subscription-id',
			endpoint: 'https://fcm.googleapis.com/subscription',
		});

		const response = await worker.fetch(
			new Request('https://worker.test/notifications/subscribe', {
				method: 'DELETE',
				headers: { 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
					Authorization: 'Bearer secret-token',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/subscription' }),
			}),
			createEnv({ DB: db.db as unknown as D1Database }) as never,
		);

		expect(response.status).toBe(200);
		expect(db.subscriptions.size).toBe(0);
	});
});
