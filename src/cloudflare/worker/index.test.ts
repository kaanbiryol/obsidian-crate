import { describe, expect, it, vi } from 'vitest';
import worker from './index';

function createEnv() {
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
});
