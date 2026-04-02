import { describe, expect, it, vi } from 'vitest';
import worker from './index';

function createDb(enrollmentTokenExpiresAt: number | null) {
	return {
		prepare: vi.fn((sql: string) => {
			const statement = {
				bind: vi.fn(() => statement),
				first: vi.fn(async () => {
					if (sql.includes('SELECT expires_at FROM push_enrollment_tokens')) {
						return enrollmentTokenExpiresAt === null ? null : { expires_at: enrollmentTokenExpiresAt };
					}
					return null;
				}),
				run: vi.fn(async () => ({})),
				all: vi.fn(async () => ({ results: [] })),
			};
			return statement;
		}),
		batch: vi.fn(async () => []),
		exec: vi.fn(async () => ({})),
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

describe('worker entrypoint', () => {
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
		const db = createDb(Date.now() + 60_000);
		const response = await worker.fetch(
			new Request('https://worker.test/notifications/subscribe', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Crate-Enrollment-Token': 'setup-token',
				},
				body: JSON.stringify({
					endpoint: 'https://push.example/subscription',
					keys: {
						p256dh: 'p256dh-key',
						auth: 'auth-key',
					},
				}),
			}),
			createEnv({ DB: db }) as never,
		);

		expect(response.status).toBe(200);
		expect(db.batch).toHaveBeenCalledTimes(1);
	});

	it('rejects expired enrollment tokens before subscribing devices', async () => {
		const db = createDb(null);
		const response = await worker.fetch(
			new Request('https://worker.test/notifications/subscribe', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Crate-Enrollment-Token': 'expired-token',
				},
				body: JSON.stringify({
					endpoint: 'https://push.example/subscription',
					keys: {
						p256dh: 'p256dh-key',
						auth: 'auth-key',
					},
				}),
			}),
			createEnv({ DB: db }) as never,
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Invalid or expired enrollment token' });
		expect(db.batch).not.toHaveBeenCalled();
	});
});
