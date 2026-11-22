/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { CRATE_PLUGIN_PROTOCOL } from '../../../protocol/server-info';
import { MAX_FILE_SIZE_BYTES, UPLOAD_PART_BYTES } from '../../../protocol/sync-limits';
import { sha256Hex } from '@/platform/sha256';
import { abortExpiredUploadSessions, UPLOAD_SESSION_PREFIX } from './upload-sessions';

const limit = 100 * 1024 * 1024;
const bindings = env as { CRATE_MAX_FILE_BYTES?: string };

beforeEach(async () => {
	vi.spyOn(console, 'info').mockImplementation(() => {});
	// Transfer objects read the binding from the shared environment, as a deployment does.
	bindings.CRATE_MAX_FILE_BYTES = String(limit);
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope) VALUES ('chunks', ?, 'vault')").bind(await sha256Hex('chunks-token')).run();
});
afterEach(async () => { delete bindings.CRATE_MAX_FILE_BYTES; vi.restoreAllMocks(); await reset(); });

const operation = () => createReminderOperationId(Math.floor(Date.now() / 86400000));
function request(route: string, init: RequestInit = {}) {
	return worker.fetch(new Request(`https://chunks.test${route}`, { ...init, headers: {
		Authorization: 'Bearer chunks-token', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), ...init.headers,
	} }), env);
}
async function attachment(size: number) {
	const content = new Uint8Array(size);
	for (let offset = 0; offset < size; offset += 4096) content[offset] = (offset / 4096) % 251;
	return { content, hash: await sha256Hex(content) };
}
const file = (hash: string, size: number, path = 'video.bin') => ({ path, hash, size, contentType: 'application/octet-stream', expectedHash: null });
const post = (action: string, id: string, body: unknown) => request(`/sync/upload-session?action=${action}`, { method: 'POST', body: JSON.stringify(body), headers: { 'X-Crate-Upload-Operation': id } });
async function sendParts(id: string, content: Uint8Array) {
	const parts: Array<{ partNumber: number; etag: string }> = [];
	for (let offset = 0, partNumber = 1; offset < content.length; offset += UPLOAD_PART_BYTES, partNumber++) {
		const response = await request(`/sync/upload-session?part=${partNumber}`, { method: 'PUT', body: content.slice(offset, offset + UPLOAD_PART_BYTES), headers: { 'X-Crate-Upload-Operation': id } });
		expect(response.status).toBe(200);
		parts.push({ partNumber, etag: (await response.json() as { etag: string }).etag });
	}
	return parts;
}
const live = () => env.DB.prepare("SELECT hash, size, storage_key FROM files WHERE path = 'video.bin'").first<{ hash: string; size: number; storage_key: string }>();

it('uploads a large attachment in parts, publishes it once and serves it in ranges', { timeout: 120_000 }, async () => {
	const size = UPLOAD_PART_BYTES + 3 * 1024 * 1024;
	const { content, hash } = await attachment(size);
	const id = operation();
	const begun = await post('begin', id, file(hash, size));
	expect(await begun.json()).toEqual({ session: { partBytes: UPLOAD_PART_BYTES } });
	// Beginning again resumes the same session.
	expect((await post('begin', id, file(hash, size))).status).toBe(200);
	const parts = await sendParts(id, content);
	const completed = await post('complete', id, { ...file(hash, size), parts });
	expect(completed.status).toBe(200);
	const receipt = await completed.json() as { success: boolean; revision: string };
	expect(receipt).toMatchObject({ success: true, hash });
	expect(await live()).toMatchObject({ hash, size, storage_key: receipt.revision });
	// A retry after a lost response answers from the receipt, at either step.
	expect(await (await post('complete', id, { ...file(hash, size), parts })).json()).toMatchObject({ success: true, revision: receipt.revision });
	expect(await (await post('begin', id, file(hash, size))).json()).toMatchObject({ success: true, revision: receipt.revision });
	expect((await env.BUCKET.list({ prefix: UPLOAD_SESSION_PREFIX })).objects).toEqual([]);

	const tail = await request('/sync/download?path=video.bin', { headers: { Range: `bytes=${UPLOAD_PART_BYTES}-${size + 100}` } });
	expect(tail.status).toBe(206);
	expect(tail.headers.get('Content-Range')).toBe(`bytes ${UPLOAD_PART_BYTES}-${size - 1}/${size}`);
	expect(new Uint8Array(await tail.arrayBuffer())).toEqual(content.slice(UPLOAD_PART_BYTES));
	expect((await request('/sync/download?path=video.bin', { headers: { Range: 'bytes=9-2' } })).status).toBe(416);
	expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM changelog').first<{ n: number }>())!.n).toBe(1);
});

it('commits a retry whose parts were already combined before the commit failed', { timeout: 120_000 }, async () => {
	const size = UPLOAD_PART_BYTES + 1024 * 1024;
	const { content, hash } = await attachment(size);
	const id = operation();
	await post('begin', id, file(hash, size));
	const parts = await sendParts(id, content);
	// The parts were combined, then the request stopped before the commit.
	const session = JSON.parse(await (await env.BUCKET.get(`${UPLOAD_SESSION_PREFIX}${id}.json`))!.text()) as { storageKey: string; uploadId: string };
	await env.BUCKET.resumeMultipartUpload(session.storageKey, session.uploadId).complete(parts);
	expect(await live()).toBeNull();
	// The client retries in its usual order: begin, every part, then complete.
	expect((await post('begin', id, file(hash, size))).status).toBe(200);
	const resent = await sendParts(id, content);
	const completed = await post('complete', id, { ...file(hash, size), parts: resent });
	expect(await completed.json()).toMatchObject({ success: true, hash });
	expect(await live()).toMatchObject({ hash, size });
});

it('publishes nothing when the parts do not match the declared hash', { timeout: 120_000 }, async () => {
	const size = UPLOAD_PART_BYTES + 1024 * 1024;
	const { content } = await attachment(size);
	const wrong = await sha256Hex(new TextEncoder().encode('another file'));
	const id = operation();
	await post('begin', id, file(wrong, size));
	const parts = await sendParts(id, content);
	const completed = await post('complete', id, { ...file(wrong, size), parts });
	expect(completed.status).toBe(400);
	expect(await live()).toBeNull();
	expect((await env.BUCKET.list({ prefix: '__crate__/files/' })).objects).toEqual([]);
});

it('refuses files that belong in one request or exceed the limit, and wrong-sized parts', async () => {
	const hash = await sha256Hex(new TextEncoder().encode('x'));
	expect((await post('begin', operation(), file(hash, MAX_FILE_SIZE_BYTES))).status).toBe(400);
	expect((await post('begin', operation(), file(hash, MAX_FILE_SIZE_BYTES + 1, 'Huge.md'))).status).toBe(400);
	expect((await post('begin', operation(), file(hash, limit + 1))).status).toBe(413);
	const id = operation();
	await post('begin', id, file(hash, UPLOAD_PART_BYTES + 10));
	const short = await request('/sync/upload-session?part=1', { method: 'PUT', body: new Uint8Array(10), headers: { 'X-Crate-Upload-Operation': id } });
	expect(short.status).toBe(400);
	expect((await request('/sync/upload-session?part=1', { method: 'PUT', body: new Uint8Array(10), headers: { 'X-Crate-Upload-Operation': operation() } })).status).toBe(404);
});

it('aborts upload sessions older than their lease', async () => {
	const hash = await sha256Hex(new TextEncoder().encode('x'));
	await post('begin', operation(), file(hash, UPLOAD_PART_BYTES + 10));
	expect((await env.BUCKET.list({ prefix: UPLOAD_SESSION_PREFIX })).objects).toHaveLength(1);
	await abortExpiredUploadSessions(env.BUCKET, Date.now() + 1000);
	expect((await env.BUCKET.list({ prefix: UPLOAD_SESSION_PREFIX })).objects).toHaveLength(1);
	await abortExpiredUploadSessions(env.BUCKET, Date.now() + 25 * 60 * 60 * 1000);
	expect((await env.BUCKET.list({ prefix: UPLOAD_SESSION_PREFIX })).objects).toEqual([]);
});
