import { describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from './http';
import { fetchCloudflareUsage } from './usage-service';

function transportFor(usage: unknown) {
	return vi.fn(async (_url: string, _request: HttpRequest) => ({ status: 200, text: JSON.stringify({ data: { viewer: { accounts: [{ usage }] } } }) }));
}

describe('Cloudflare usage', () => {
	it('queries account totals and UTC periods, using rows rather than query counts', async () => {
		const transport = transportFor([{ sum: { requests: 120, rowsRead: 456, rowsWritten: 10 }, dimensions: { actionType: 'GetObject' }, max: { databaseSizeBytes: 100, payloadSize: 200, metadataSize: 5 } }]);
		const result = await fetchCloudflareUsage(transport, 'secret', 'account', new Date('2026-09-01T00:05:00Z'));
		expect(result[0]?.metrics[0]?.used).toBe(120);
		expect(result[1]?.metrics.map(m => m.used)).toEqual([456, 10]);
		expect(result[2]?.metrics.map(m => m.used)).toEqual([0, 120]);
		expect(result[3]?.metrics.map(m => m.used)).toEqual([100, 205]);
		const requests = JSON.stringify(transport.mock.calls);
		// Queries must never filter down to only Crate's share of account-wide allowances.
		expect(requests).not.toContain('scriptName');
		expect(requests).not.toContain('readQueries');
		expect(requests).toContain('2026-09-01T00:00:00Z');
		expect(requests).toContain('2026-09-01T00:05:00.000Z');
		expect(transport.mock.calls.every(([, request]) => (JSON.parse(request.body as string) as { query: string }).query.includes('accountTag: "account"'))).toBe(true);
	});

	it('does not count free deletes as class B, and rejects unknown actions', async () => {
		const result = await fetchCloudflareUsage(transportFor([
			{ dimensions: { actionType: 'DeleteObject' }, sum: { requests: 900 } },
			{ dimensions: { actionType: 'PutObject' }, sum: { requests: 3 } },
		]), 'token', 'account');
		expect(result[2]?.metrics.map(m => m.used)).toEqual([3, 0]);
		const unknown = await fetchCloudflareUsage(transportFor([{ dimensions: { actionType: 'NewAction' }, sum: { requests: 1 } }]), 'token', 'account');
		expect(unknown[2]?.error).toContain('unrecognized');
	});

	it('does not present missing, malformed, or truncated data as unused quota', async () => {
		for (const rows of [null, [{}], Array.from({ length: 10000 }, () => ({}))]) {
			const result = await fetchCloudflareUsage(transportFor(rows), 'token', 'account');
			expect(result.every(group => group.error && group.metrics.length === 0)).toBe(true);
		}
	});

	it('keeps valid services visible when a dataset fails', async () => {
		let call = 0;
		const transport = vi.fn(async () => (++call === 1
			? { status: 403, text: 'secret detail' }
			: { status: 200, text: JSON.stringify({ data: { viewer: { accounts: [{ usage: [] }] } } }) }));
		const result = await fetchCloudflareUsage(transport, 'token', 'account');
		expect(result[0]?.error).toContain('Reconnect Cloudflare usage');
		expect(result[1]?.metrics.map(m => m.used)).toEqual([0, 0]);
		expect(JSON.stringify(result)).not.toContain('secret detail');
		expect(result[3]?.error).toBeTruthy();
	});
});
