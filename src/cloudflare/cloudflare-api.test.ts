import { describe, expect, it, vi } from 'vitest';
import { buildWorkerMultipartBody, CloudflareApiClient, CloudflareApiError } from './cloudflare-api';
import type { HttpTransport } from './http';

const artifacts = {
	version: '0.1.0',
	workerBundle: 'export class ReminderAlarm {}\nexport class SetupCoordinator {}',
	workerBundleSha256: 'worker-hash',
	d1Migrations: [],
};

describe('CloudflareApiClient', () => {
	it('builds a module upload with D1, R2, and declarative Durable Object bindings', () => {
		const multipart = buildWorkerMultipartBody({
			artifacts,
			d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
			r2BucketName: 'crate-0123456789abcdef',
		});
		const body = new TextDecoder().decode(multipart.body);

		expect(multipart.contentType).toMatch(/^multipart\/form-data; boundary=crate-/);
		expect(body).toContain('"type":"d1","name":"DB"');
		expect(body).toContain('"type":"r2_bucket","name":"BUCKET"');
		expect(body).toContain('"name":"REMINDER_ALARMS","class_name":"ReminderAlarm"');
		expect(body).toContain('"name":"SETUP","class_name":"SetupCoordinator"');
		expect(body).toContain('"storage":"sqlite","state":"created"');
		expect(body).toContain(artifacts.workerBundle);
	});

	it('uses a bearer token only in the request header', async () => {
		const transportImplementation: HttpTransport = async () => ({
			status: 200,
			text: JSON.stringify({
				success: true,
				result: [{ status: 'accepted', account: { id: 'account-id', name: 'Personal' } }],
			}),
		});
		const transport = vi.fn(transportImplementation);
		const client = new CloudflareApiClient('temporary-token', transport);

		await expect(client.listAuthorizedAccounts()).resolves.toEqual([
			{ id: 'account-id', name: 'Personal' },
		]);
		expect(transport.mock.calls[0]?.[1].headers).toMatchObject({ Authorization: 'Bearer temporary-token' });
		expect(transport.mock.calls[0]?.[0]).not.toContain('temporary-token');
	});

	it('preserves Cloudflare error codes for actionable R2 handling', async () => {
		const client = new CloudflareApiClient('token', vi.fn(async () => ({
			status: 403,
			text: JSON.stringify({
				success: false,
				result: null,
				errors: [{ code: 10042, message: 'not entitled' }],
			}),
		})));

		let error: unknown;
		try {
			await client.getR2Bucket('account', 'bucket');
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(CloudflareApiError);
		if (!(error instanceof CloudflareApiError)) throw new Error('Expected CloudflareApiError');
		expect(error.code).toBe(10042);
	});
});
