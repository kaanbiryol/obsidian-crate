/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import worker from './reset-worker.js';
import schema from '../schema.sql?raw';
import { sha256Hex } from '../deployment-artifacts';
import { DEPLOYMENT_FENCE_KEY } from '../deployment-fence';

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const token = 'b'.repeat(64), resetId = 'c'.repeat(32);
const object = (id: number) => `__crate__/files/${id.toString(16).padStart(64, '0')}/01234567-89ab-cdef-0123-456789abcdef`;
const url = 'https://crate-0123456789abcdef.example.workers.dev';

async function harness(keys = [object(0)], overrides: Record<string, unknown> = {}) {
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	const record = { owner: '12345678-1234-1234-1234-123456789012', worker: 'crate-0123456789abcdef', kind: 'delete',
		resetId, recoveryProtocol: 1, cleanupTokenHash: await sha256Hex(token), step: 'deleteR2Objects', stepState: 'started',
		batchHash: await sha256Hex(JSON.stringify(keys)), ...overrides };
	const save = async (value = record) => env.DB.prepare('INSERT OR REPLACE INTO maintenance_state(key, value) VALUES (?, ?)')
		.bind(DEPLOYMENT_FENCE_KEY, JSON.stringify(value)).run();
	await save();
	const bucket = { delete: vi.fn(async (items: string | string[]) => env.BUCKET.delete(items)) };
	const bindings = { DB: env.DB, BUCKET: bucket, CRATE_RESET_ID: resetId };
	const request = (items = keys, credential = token) => new Request(`${url}/__crate__/reset/objects`, {
		method: 'POST', headers: { Authorization: `Bearer ${credential}` }, body: JSON.stringify(items),
	});
	return { bindings, bucket, request, record, save, fetch: (items = keys, credential = token) => worker.fetch(request(items, credential), bindings) };
}

it('executes one native R2 bulk delete for 1,000 exact keys and returns a verifiable receipt', async () => {
	const keys = Array.from({ length: 1000 }, (_, i) => object(i));
	const h = await harness(keys);
	await env.BUCKET.put(keys[0]!, 'first');
	await env.BUCKET.put(keys[999]!, 'last');
	await env.BUCKET.put('unrelated-photo.jpg', 'keep');
	const response = await h.fetch();
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ service: 'crate-reset', protocol: 1, resetId, deleted: 1000, batchHash: h.record.batchHash });
	expect(h.bucket.delete).toHaveBeenCalledExactlyOnceWith(keys);
	expect((await env.BUCKET.list()).objects.map(item => item.key)).toEqual(['unrelated-photo.jpg']);
	// An identical in-flight request is idempotent while the exact batch is active.
	expect((await h.fetch()).status).toBe(200);
});

it.each(['', 'account-management-token', 'a'.repeat(64)])('rejects a missing or incorrect cleanup credential', async credential => {
	const h = await harness();
	expect((await h.fetch(undefined, credential)).status).toBe(401);
	expect(h.bucket.delete).not.toHaveBeenCalled();
});

it.each([{ kind: 'update' }, { resetId: 'old' }, { recoveryProtocol: 2 }, { step: 'retireCrateWorker' },
	{ stepState: 'confirmed' }, { verificationPending: true }])('rejects an inactive or different cleanup operation: %j', async record => {
	const h = await harness(undefined, record);
	expect((await h.fetch()).status).toBe(409);
	expect(h.bucket.delete).not.toHaveBeenCalled();
});

it('rejects an altered batch before any object deletion', async () => {
	const h = await harness();
	expect((await h.fetch([object(1)])).status).toBe(403);
	expect(h.bucket.delete).not.toHaveBeenCalled();
});

it('revokes old credentials when a permanent deletion takes new ownership', async () => {
	const h = await harness();
	const nextToken = 'd'.repeat(64);
	await h.save({ ...h.record, owner: crypto.randomUUID(), cleanupTokenHash: await sha256Hex(nextToken) });
	expect((await h.fetch()).status).toBe(401);
	expect(h.bucket.delete).not.toHaveBeenCalled();
	expect((await h.fetch(undefined, nextToken)).status).toBe(200);
});

it('rechecks ownership after validating keys before dispatching the delete', async () => {
	const h = await harness(['legacy.md']);
	await env.DB.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('legacy.md', 'legacy.md', 'legacy.md')").run();
	const prepare = env.DB.prepare.bind(env.DB);
	let reads = 0;
	const db = { ...env.DB, prepare: (sql: string) => {
		const statement = prepare(sql);
		if (!sql.startsWith('SELECT value')) return statement;
		return { bind: (...args: unknown[]) => ({ first: async () => {
			if (++reads === 2) await h.save({ ...h.record, owner: crypto.randomUUID() });
			return statement.bind(...args).first();
		} }) } as D1PreparedStatement;
	} } as D1Database;
	expect((await worker.fetch(h.request(), { ...h.bindings, DB: db })).status).toBe(409);
	expect(h.bucket.delete).not.toHaveBeenCalled();
});

it('validates all objects before deleting any, including a valid key mixed with an unrelated file', async () => {
	const h = await harness([object(0), 'personal-photo.jpg']);
	await env.BUCKET.put(object(0), 'keep');
	expect((await h.fetch()).status).toBe(403);
	expect(h.bucket.delete).not.toHaveBeenCalled();
	expect(await env.BUCKET.get(object(0))).not.toBeNull();
});

it('accepts exact legacy references from current files, versions and pending cleanup', async () => {
	const h = await harness(['legacy #é.md', 'old-version', 'orphan-upload', '__crate__/settings.json']);
	await env.DB.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('legacy.md', 'legacy.md', 'legacy #é.md')").run();
	await env.DB.prepare("INSERT INTO file_versions(storage_key, path, hash, size, reason, expires_at) VALUES ('old-version', 'legacy.md', 'hash', 1, 'replaced', 1)").run();
	await env.DB.prepare("INSERT INTO object_cleanup_queue(storage_key) VALUES ('orphan-upload')").run();
	expect((await h.fetch()).status).toBe(200);
	expect(h.bucket.delete).toHaveBeenCalledOnce();
});

it.each([[], ['duplicate', 'duplicate'], ['../unsafe'], Array.from({ length: 1001 }, (_, i) => object(i))].map(keys => ({ keys })))('rejects malformed or oversized batches (%#)', async ({ keys }) => {
	const h = await harness(keys);
	expect((await h.fetch()).status).toBe(400);
	expect(h.bucket.delete).not.toHaveBeenCalled();
});

it('bounds the actual request body without relying on Content-Length', async () => {
	const h = await harness();
	const request = new Request(`${url}/__crate__/reset/objects`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: ' '.repeat(1_100_001) });
	expect((await worker.fetch(request, h.bindings)).status).toBe(400);
	expect(h.bucket.delete).not.toHaveBeenCalled();
});

it('reports uncertain failure after a possibly applied R2 deletion', async () => {
	const h = await harness();
	await env.BUCKET.put(object(0), 'file');
	h.bucket.delete.mockImplementationOnce(async keys => { await env.BUCKET.delete(keys); throw new Error('lost response'); });
	expect((await h.fetch()).status).toBe(503);
	expect(await env.BUCKET.get(object(0))).toBeNull();
	expect((await h.fetch()).status).toBe(200);
});

it('keeps normal sync and web routes offline and exposes only non-secret readiness metadata', async () => {
	const h = await harness();
	for (const path of ['/', '/sync/upload', '/notifications', '/__crate__/reset/objects']) {
		expect((await worker.fetch(new Request(`${url}${path}`), h.bindings)).status).toBe(503);
	}
	const response = await worker.fetch(new Request(`${url}/.well-known/crate-reset`), h.bindings);
	expect(await response.json()).toEqual({ service: 'crate-reset', protocol: 1, resetId });
	expect(response.headers.get('Cache-Control')).toBe('no-store');
	expect(h.bucket.delete).not.toHaveBeenCalled();
});
