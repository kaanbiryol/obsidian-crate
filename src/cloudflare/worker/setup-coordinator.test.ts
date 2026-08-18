import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './auth';
import { SetupCoordinator } from './setup-coordinator';

function createStorage() {
	const values = new Map<string, unknown>();
	const storage = {
		put: vi.fn(async (key: string, value: unknown) => {
			values.set(key, value);
		}),
		get: vi.fn(async (key: string) => values.get(key)),
		delete: vi.fn(async (key: string) => values.delete(key)),
		deleteAll: vi.fn(async () => values.clear()),
		setAlarm: vi.fn(async () => {}),
		getAlarm: vi.fn(async () => null),
		deleteAlarm: vi.fn(async () => {}),
	};
	return { values, storage: storage as unknown as DurableObjectStorage };
}

function createDb(options?: { failInsert?: boolean }) {
	const statements: Array<{ sql: string; args: unknown[] }> = [];
	const db = {
		prepare: vi.fn((sql: string) => {
			const entry = { sql, args: [] as unknown[] };
			statements.push(entry);
			const statement = {
				bind: vi.fn((...args: unknown[]) => {
					entry.args = args;
					return statement;
				}),
				first: vi.fn(async () => null),
				run: vi.fn(async () => {
					if (options?.failInsert && sql.includes('INSERT INTO auth_tokens')) {
						throw new Error('D1 insert failed');
					}
					return {};
				}),
				all: vi.fn(async () => {
					if (sql.includes('PRAGMA table_info(files)')) {
						return { results: [{ name: 'storage_key' }] };
					}
					if (sql.includes('PRAGMA table_info(auth_tokens)')) {
						return { results: [
							{ name: 'device_id' },
							{ name: 'platform' },
							{ name: 'last_seen_at' },
						] };
					}
					return { results: [] };
				}),
			};
			return statement;
		}),
		batch: vi.fn(async () => []),
		exec: vi.fn(async () => ({})),
	};
	return { db: db as unknown as D1Database, statements };
}

function createCoordinator(db: D1Database | null = null) {
	const { storage } = createStorage();
	return new SetupCoordinator(
		{ storage } as DurableObjectState,
		{ DB: db },
	);
}

async function claim(coordinator: SetupCoordinator, enrollmentToken: string): Promise<Response> {
	return coordinator.fetch(new Request('https://worker.test/setup/claim', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ enrollmentTokenHash: await sha256Hex(enrollmentToken) }),
	}));
}

describe('SetupCoordinator', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('allows exactly one browser to claim a new server', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'));
		const coordinator = createCoordinator();

		const first = await claim(coordinator, 'first-enrollment-token');
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			claimed: true,
			expiresAt: '2026-08-18T12:10:00.000Z',
		});

		const second = await claim(coordinator, 'second-enrollment-token');
		expect(second.status).toBe(409);
		expect(await second.json()).toEqual({ error: 'Server already claimed' });
	});

	it('exchanges the short-lived enrollment token for one device token', async () => {
		const { db, statements } = createDb();
		const coordinator = createCoordinator(db);
		const enrollmentToken = 'one-time-enrollment-token';
		await claim(coordinator, enrollmentToken);
		const deviceTokenHash = await sha256Hex('device-secret');

		const response = await coordinator.fetch(new Request('https://worker.test/setup/enroll', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				enrollmentToken,
				deviceTokenHash,
				deviceId: 'device-1',
				deviceName: 'Mac',
				platform: 'desktop',
			}),
		}));

		expect(response.status).toBe(200);
		expect(statements.some(({ sql, args }) =>
			sql.includes('INSERT INTO auth_tokens') && args.includes(deviceTokenHash))).toBe(true);

		const replay = await coordinator.fetch(new Request('https://worker.test/setup/enroll', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enrollmentToken, deviceTokenHash }),
		}));
		expect(replay.status).toBe(401);

		const status = await coordinator.fetch(new Request('https://worker.test/setup/status'));
		expect(await status.json()).toEqual({ claimed: true, enrollmentAvailable: false });
	});

	it('lets an authenticated device replace the pending enrollment token', async () => {
		const coordinator = createCoordinator();
		await claim(coordinator, 'initial-token');
		const nextTokenHash = await sha256Hex('next-device-token');

		const response = await coordinator.fetch(new Request('https://worker.test/setup/authorize-enrollment', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enrollmentTokenHash: nextTokenHash }),
		}));

		expect(response.status).toBe(200);
		const status = await coordinator.fetch(new Request('https://worker.test/setup/status'));
		expect(await status.json()).toMatchObject({
			claimed: true,
			enrollmentAvailable: true,
			enrollmentTokenHash: nextTokenHash,
		});
	});

	it('restores enrollment when D1 registration fails', async () => {
		const { db } = createDb({ failInsert: true });
		const coordinator = createCoordinator(db);
		const enrollmentToken = 'retryable-enrollment-token';
		await claim(coordinator, enrollmentToken);

		const response = await coordinator.fetch(new Request('https://worker.test/setup/enroll', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				enrollmentToken,
				deviceTokenHash: await sha256Hex('device-secret'),
			}),
		}));

		expect(response.status).toBe(503);
		const status = await coordinator.fetch(new Request('https://worker.test/setup/status'));
		expect(await status.json()).toEqual({
			claimed: true,
			enrollmentAvailable: true,
			enrollmentTokenHash: await sha256Hex(enrollmentToken),
		});
	});
});
