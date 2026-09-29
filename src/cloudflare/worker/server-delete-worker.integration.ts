/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { sha256Hex } from '../deployment-artifacts';
import worker from './server-delete-worker.js';

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const token = 'b'.repeat(64), id = 'c'.repeat(32), uploadTag = `crate-${crypto.randomUUID()}`;
const origin = `https://crate-delete-${id}.example.workers.dev`;

async function harness() {
	const bucket = { delete: vi.fn(async (keys: string | string[]) => env.BUCKET.delete(keys)) };
	const bindings = { BUCKET: bucket, CRATE_RESET_ID: id, CRATE_DELETE_TOKEN_HASH: await sha256Hex(token), CRATE_DELETE_UPLOAD_TAG: uploadTag };
	const request = (keys: unknown, credential = token) => new Request(`${origin}/__crate__/reset/objects`, {
		method: 'POST', headers: { Authorization: `Bearer ${credential}` }, body: JSON.stringify(keys),
	});
	return { bucket, bindings, fetch: (keys: unknown, credential = token) => worker.fetch(request(keys, credential), bindings) };
}

it('removes arbitrary old and future object formats using R2 without a D1 binding or application schema', async () => {
	const h = await harness();
	const keys = ['legacy.md', 'future/unknown.format', '__crate__/backups/unknown', '../opaque-key', 'unicode/é #1'];
	for (const key of keys) await env.BUCKET.put(key, 'file');
	await env.BUCKET.put('not-in-this-batch', 'later');
	const response = await h.fetch(keys);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ service: 'crate-reset', protocol: 1, resetId: id, deleted: keys.length,
		batchHash: await sha256Hex(JSON.stringify(keys)) });
	expect(h.bucket.delete).toHaveBeenCalledExactlyOnceWith(keys);
	expect((await env.BUCKET.list()).objects.map(object => object.key)).toEqual(['not-in-this-batch']);
});

it.each(['', 'account-management-secret', 'a'.repeat(64)])('rejects invalid cleanup credentials: %s', async credential => {
	const h = await harness();
	expect((await h.fetch(['old.md'], credential)).status).toBe(401);
	expect(h.bucket.delete).not.toHaveBeenCalled();
});

it.each([[], ['duplicate', 'duplicate'], ['a'.repeat(1025)], [42], Array.from({ length: 1001 }, (_, i) => `key-${i}`)].map(keys => ({ keys })))('rejects malformed batches (%#)', async ({ keys }) => {
	const h = await harness();
	expect((await h.fetch(keys)).status).toBe(400);
	expect(h.bucket.delete).not.toHaveBeenCalled();
});

it('bounds streamed input without trusting Content-Length', async () => {
	const h = await harness();
	const request = new Request(`${origin}/__crate__/reset/objects`, { method: 'POST',
		headers: { Authorization: `Bearer ${token}` }, body: ' '.repeat(1_100_001) });
	expect((await worker.fetch(request, h.bindings)).status).toBe(400);
	expect(h.bucket.delete).not.toHaveBeenCalled();
});

it('rotates the private cleanup capability without publishing its value', async () => {
	const h = await harness(), next = 'd'.repeat(64);
	h.bindings.CRATE_DELETE_TOKEN_HASH = await sha256Hex(next);
	expect((await h.fetch(['old.md'])).status).toBe(401);
	expect((await h.fetch(['old.md'], next)).status).toBe(200);
	const ready = await worker.fetch(new Request(`${origin}/.well-known/crate-reset`), h.bindings);
	expect(await ready.json()).toEqual({ service: 'crate-reset', protocol: 1, resetId: id, recoveryObjects: true, deleteAll: true, uploadTag });
	expect(ready.headers.get('Cache-Control')).toBe('no-store');
});

it('can repeat an exact deletion after a lost native R2 response', async () => {
	const h = await harness(); await env.BUCKET.put('old.md', 'file');
	h.bucket.delete.mockImplementationOnce(async keys => { await env.BUCKET.delete(keys); throw new Error('response lost'); });
	expect((await h.fetch(['old.md'])).status).toBe(503);
	expect(await env.BUCKET.get('old.md')).toBeNull();
	expect((await h.fetch(['old.md'])).status).toBe(200);
});

it('exposes no sync, web app, or write routes', async () => {
	const h = await harness();
	for (const path of ['/', '/sync/upload', '/notifications', '/__crate__/reset/objects']) {
		expect((await worker.fetch(new Request(`${origin}${path}`), h.bindings)).status).toBe(503);
	}
	expect(h.bucket.delete).not.toHaveBeenCalled();
});
