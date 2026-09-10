import { describe, expect, it, vi } from 'vitest';
import { buildWorkerMultipartBody, buildResetWorkerMultipartBody, CloudflareApiClient, CloudflareApiError } from './cloudflare-api';
import type { HttpTransport } from './http';

const artifacts = {
	version: '0.1.0',
	fingerprint: 'f'.repeat(64),
	workerBundle: 'export class ReminderAlarm {}',
	workerBundleSha256: 'worker-hash',
	d1Schema: 'CREATE TABLE IF NOT EXISTS example (id TEXT);',
	d1SchemaSha256: 'schema-hash',
};

describe('CloudflareApiClient', () => {
	it('deletes exactly the requested D1 database with no other requests', async () => {
		const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify({ success: true, result: {} }) }));
		await new CloudflareApiClient('token', transport).deleteD1Database('account', 'database');
		expect(transport).toHaveBeenCalledOnce();
		expect(transport).toHaveBeenCalledWith('https://api.cloudflare.com/client/v4/accounts/account/d1/database/database', expect.objectContaining({ method: 'DELETE' }));
	});

	it('retires only ReminderAlarm using a deleted export and an offline Worker with no public cleanup route', () => {
		const body = new TextDecoder().decode(buildResetWorkerMultipartBody('reset-id', 'database', 'crate-bucket').body);
		expect(body).toContain('"ReminderAlarm":{"type":"durable-object","state":"deleted"}');
		expect(body).not.toContain('export class');
		expect(body).not.toContain('force');
		expect(body).toContain('status: 503');
		expect(body).toContain('Crate reset reset-id');
	});

	it('reads R2 pagination metadata and encodes object keys without encoding path separators', async () => {
		const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify({
			success: true, result: [{ key: 'Notes/a #b.md' }], result_info: { is_truncated: true, cursor: 'next/page' },
		}) }));
		const client = new CloudflareApiClient('token', transport);
		expect(await client.listR2Objects('account', 'crate-bucket', 'first/page')).toEqual({ keys: ['Notes/a #b.md'], cursor: 'next/page' });
		expect(transport.mock.calls[0]?.[0]).toContain('cursor=first%2Fpage');
		await client.deleteR2Object('account', 'crate-bucket', 'Notes/a #b.md');
		expect(transport.mock.calls[1]?.[0]).toBe('https://api.cloudflare.com/client/v4/accounts/account/r2/buckets/crate-bucket/objects/Notes/a%20%23b.md');
		await expect(client.deleteR2Object('account', 'crate-bucket', '../../other')).rejects.toThrow('Unsafe');
		expect(transport).toHaveBeenCalledTimes(2);
	});

	it('rejects an ambiguous truncated R2 listing', async () => {
		const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify({ success: true, result: [], result_info: { is_truncated: true } }) }));
		await expect(new CloudflareApiClient('token', transport).listR2Objects('account', 'bucket')).rejects.toThrow('complete R2');
	});

	it('reads all Durable Object namespace pages', async () => {
		let page = 0;
		const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify({ success: true,
			result: [{ id: String(++page), class: 'Class', script: 'script' }], result_info: { page, total_pages: 2 },
		}) }));
		const namespaces = await new CloudflareApiClient('token', transport).listDurableObjectNamespaces('account');
		expect(namespaces.map(namespace => namespace.id)).toEqual(['1', '2']);
		expect(transport.mock.calls[1]?.[0]).toContain('page=2');
	});

	it.each([undefined, { page: 1 }, { count: 1 }])('reads through an empty page with optional metadata %j', async info => {
		let calls = 0;
		const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify({
			success: true,
			result: ++calls <= 2 ? [{ id: String(calls), class: 'Class', script: 'script' }] : [],
			result_info: info && { ...info, ...('page' in info ? { page: calls } : {}) },
		}) }));
		expect(await new CloudflareApiClient('token', transport).listDurableObjectNamespaces('account')).toHaveLength(2);
		expect(transport).toHaveBeenCalledTimes(3);
	});

	it('accepts an empty namespace inventory without pagination metadata', async () => {
		const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify({ success: true, result: [] }) }));
		expect(await new CloudflareApiClient('token', transport).listDurableObjectNamespaces('account')).toEqual([]);
		expect(transport).toHaveBeenCalledOnce();
	});

	it.each([
		{ result: [{ id: 'repeated' }] },
		{ result: null },
		{ result: [null] },
		{ result: [{}] },
		{ result: [], result_info: { total_pages: 2 } },
		{ result: [], result_info: { page: 2 } },
		{ result: [], result_info: { total_pages: '2' } },
	])('rejects incomplete or malformed namespace listings: %j', async response => {
		const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify({ success: true, ...response }) }));
		await expect(new CloudflareApiClient('token', transport).listDurableObjectNamespaces('account')).rejects.toThrow('complete Durable Object');
		expect(transport.mock.calls.length).toBeLessThanOrEqual(2);
	});

	it('builds a module upload with D1, R2, and declarative Durable Object bindings', () => {
		const multipart = buildWorkerMultipartBody({
			publicOrigin: 'https://worker.test',
			artifacts,
			d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
			r2BucketName: 'crate-0123456789abcdef',
		});
		const body = new TextDecoder().decode(multipart.body);

		expect(multipart.contentType).toMatch(/^multipart\/form-data; boundary=crate-/);
		expect(body).toContain('"type":"d1","name":"DB"');
		expect(body).toContain('"name":"CRATE_PUBLIC_ORIGIN","text":"https://worker.test"');
		expect(body).toContain('"type":"r2_bucket","name":"BUCKET"');
		expect(body).toContain('"name":"REMINDER_ALARMS","class_name":"ReminderAlarm"');
		expect(body).not.toContain('"name":"SETUP"');
		expect(body).not.toContain('SetupCoordinator');
		expect(body).toContain('"storage":"sqlite","state":"created"');
		expect(body).toContain('"workers/tag":"crate"');
		expect(body).toContain(`"workers/message":"Crate 0.1.0 ${'f'.repeat(64)}"`);
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

	it('replaces Worker cron triggers with the requested maintenance schedules', async () => {
		const transport = vi.fn<HttpTransport>(async () => ({
			status: 200,
			text: JSON.stringify({ success: true, result: { schedules: [] } }),
		}));
		const client = new CloudflareApiClient('token', transport);

		await client.updateWorkerSchedules('account', 'crate worker', ['*/15 * * * *']);

		expect(transport).toHaveBeenCalledWith(
			'https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/crate%20worker/schedules',
			expect.objectContaining({
				method: 'PUT',
				body: JSON.stringify([{ cron: '*/15 * * * *' }]),
			}),
		);
	});

	it('rejects a D1 response when any SQL statement reports failure', async () => {
		const client = new CloudflareApiClient('token', vi.fn(async () => ({
			status: 200,
			text: JSON.stringify({
				success: true,
				result: [{ success: false, error: 'duplicate column' }],
			}),
		})));

		await expect(client.queryD1('account', 'database', 'ALTER TABLE example'))
			.rejects.toThrow('failed SQL statement');
	});
});


describe('Worker deletion', () => {
	it.each(['', JSON.stringify({ success: true, result: null })])('accepts a successful delete response: %s', async text => {
		const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text }));
		await new CloudflareApiClient('token', transport).deleteWorker('account', 'crate-server');
		expect(transport).toHaveBeenCalledExactlyOnceWith('https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/crate-server', {
			method: 'DELETE', headers: { Authorization: 'Bearer token' },
		});
	});

	it.each([
		{ status: 403, text: '' },
		{ status: 200, text: JSON.stringify({ success: false }) },
		{ status: 200, text: 'invalid response' },
	])('rejects an unsuccessful or ambiguous response', async response => {
		const transport = vi.fn<HttpTransport>(async () => response);
		await expect(new CloudflareApiClient('token', transport).deleteWorker('account', 'crate-server')).rejects.toThrow();
	});
});


describe('R2 cursor pagination compatibility', () => {
	it.each([undefined, {}, { cursor: '' }, { cursor: null }, { is_truncated: false }])('accepts a terminal page with metadata %j', async result_info => {
		const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify({ success: true, result: [{ key: 'file.md' }], result_info }) }));
		expect(await new CloudflareApiClient('token', transport).listR2Objects('account', 'bucket')).toEqual({ keys: ['file.md'] });
	});

	it('accepts an empty bucket without optional pagination metadata', async () => {
		const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify({ success: true, result: [] }) }));
		expect(await new CloudflareApiClient('token', transport).listR2Objects('account', 'bucket')).toEqual({ keys: [] });
	});

	it('follows a cursor-only page through the terminal page', async () => {
		const transport = vi.fn<HttpTransport>()
			.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ success: true, result: [{ key: 'first.md' }], result_info: { cursor: 'next/page' } }) })
			.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ success: true, result: [{ key: 'last.md' }] }) });
		const client = new CloudflareApiClient('token', transport);
		const first = await client.listR2Objects('account', 'bucket');
		expect(first.cursor).toBe('next/page');
		const last = await client.listR2Objects('account', 'bucket', first.cursor);
		expect(last).toEqual({ keys: ['last.md'] });
		expect(transport.mock.calls[1]![0]).toContain('cursor=next%2Fpage');
	});

	it.each([
		{ result: [null] }, { result: {} }, { result: [{ key: 42 }] },
		{ result: [], result_info: { cursor: 42 } },
		{ result: [], result_info: { is_truncated: 'true' } },
		{ result: [], result_info: { is_truncated: true } },
		{ result: [], result_info: { is_truncated: false, cursor: 'next' } },
		{ result: [], result_info: { cursor: 'current' } },
	])('rejects malformed or non-advancing pagination: %j', async payload => {
		const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify({ success: true, ...payload }) }));
		await expect(new CloudflareApiClient('token', transport).listR2Objects('account', 'bucket', 'current')).rejects.toThrow('complete R2');
	});
});
