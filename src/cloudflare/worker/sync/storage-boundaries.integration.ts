/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { CRATE_PLUGIN_PROTOCOL } from '../../../protocol/server-info';
import { formatFileLimit, MAX_FILE_SIZE_BYTES, SELF_HOSTED_BATCH_LIMITS } from '../../../protocol/sync-limits';
import { sha256Hex } from '@/platform/sha256';

beforeEach(async () => {
	vi.spyOn(console, 'info').mockImplementation(() => {});
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope) VALUES ('boundary', ?, 'vault')")
		.bind(await sha256Hex('boundary-token')).run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

function request(route: string, init: RequestInit = {}) {
	return worker.fetch(new Request(`https://boundaries.test${route}`, { ...init, headers: {
		Authorization: 'Bearer boundary-token', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), ...init.headers,
	} }), env);
}
async function liveFile() {
	return env.DB.prepare("SELECT hash, size, storage_key FROM files WHERE path = 'attachment.bin'")
		.first<{ hash: string; size: number; storage_key: string }>();
}

it('round-trips the exact 25 MiB attachment boundary through authenticated Worker, D1 and R2',
	{ timeout: 120_000 }, async () => {
		const content = new Uint8Array(MAX_FILE_SIZE_BYTES);
		for (let offset = 0; offset < content.length; offset += 1024) content[offset] = (offset / 1024) % 251;
		const hash = await sha256Hex(content);
		const uploaded = await request('/sync/upload?path=attachment.bin', { method: 'PUT', body: content,
			headers: { 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)), 'X-Crate-Expected-Hash': 'absent', 'X-File-Size': String(content.length), 'X-File-Hash': hash } });
		expect(uploaded.status).toBe(200);
		expect(await liveFile()).toMatchObject({ hash, size: MAX_FILE_SIZE_BYTES });
		const downloaded = await request('/sync/download?path=attachment.bin');
		expect(downloaded.status).toBe(200);
		const body = await downloaded.arrayBuffer();
		expect(body.byteLength).toBe(MAX_FILE_SIZE_BYTES);
		expect(await sha256Hex(body)).toBe(hash);
	});

it('rejects an undeclared streamed byte over the attachment limit without touching the previous incarnation',
	{ timeout: 120_000 }, async () => {
		expect((await request('/sync/upload?path=attachment.bin', { method: 'PUT', body: 'preserved',
			headers: { 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)), 'X-Crate-Expected-Hash': 'absent' } })).status).toBe(200);
		const before = await liveFile();
		const put = vi.spyOn(env.BUCKET, 'put');
		let remaining = MAX_FILE_SIZE_BYTES + 1;
		const stream = new ReadableStream<Uint8Array>({ pull(controller) {
			const bytes = Math.min(1024 * 1024, remaining);
			controller.enqueue(new Uint8Array(bytes)); remaining -= bytes;
			if (!remaining) controller.close();
		} });
		const rejected = await request('/sync/upload?path=attachment.bin', { method: 'PUT', body: stream,
			headers: { 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)), 'X-Crate-Expected-Hash': before!.hash } });
		expect(rejected.status).toBe(413);
		expect(put).not.toHaveBeenCalled();
		expect(await liveFile()).toEqual(before);
		expect(await (await request('/sync/download?path=attachment.bin')).text()).toBe('preserved');
		expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM changelog').first<{ n: number }>())!.n).toBe(1);
	});

it('preserves the prior live object and checkpoint metadata when an R2 write fails before publication', async () => {
	expect((await request('/sync/upload?path=attachment.bin', { method: 'PUT', body: 'preserved',
		headers: { 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)), 'X-Crate-Expected-Hash': 'absent' } })).status).toBe(200);
	const before = await liveFile();
	vi.spyOn(env.BUCKET, 'put').mockRejectedValueOnce(new Error('R2 unavailable at durable write'));
	const failed = await request('/sync/upload?path=attachment.bin', { method: 'PUT', body: 'replacement',
		headers: { 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)), 'X-Crate-Expected-Hash': before!.hash } });
	expect(failed.status).toBeGreaterThanOrEqual(500);
	expect(await liveFile()).toEqual(before);
	expect(await (await request('/sync/download?path=attachment.bin')).text()).toBe('preserved');
	expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM changelog').first<{ n: number }>())!.n).toBe(1);
});

describe('a self-hosted server with a raised file limit', () => {
	const limit = MAX_FILE_SIZE_BYTES + 5 * 1024 * 1024;
	// Transfer objects read the binding from the shared environment, as a deployment does.
	beforeEach(() => { (env as { CRATE_MAX_FILE_BYTES?: string }).CRATE_MAX_FILE_BYTES = String(limit); });
	afterEach(() => { delete (env as { CRATE_MAX_FILE_BYTES?: string }).CRATE_MAX_FILE_BYTES; });
	const raised = () => env;
	const send = (route: string, init: RequestInit = {}, protocol = CRATE_PLUGIN_PROTOCOL.current) => worker.fetch(new Request(`https://boundaries.test${route}`, { ...init, headers: {
		Authorization: 'Bearer boundary-token', 'X-Crate-Protocol': String(protocol), ...init.headers,
	} }), raised());
	const upload = (body: BodyInit, headers: Record<string, string>, protocol?: number) => send('/sync/upload?path=attachment.bin', { method: 'PUT', body,
		headers: { 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)), 'X-Crate-Expected-Hash': 'absent', ...headers } }, protocol);

	it('advertises its limit', async () => {
		const info = await (await send('/.well-known/crate')).json() as { limits: unknown; protocol: unknown; capabilities: string[] };
		expect(info.limits).toEqual({ maxFileBytes: limit, batch: SELF_HOSTED_BATCH_LIMITS });
		expect(info.capabilities).toContain('chunked-uploads-v1');
		expect(info.protocol).toEqual(CRATE_PLUGIN_PROTOCOL);
	});

	it('round-trips a file above the default limit and refuses one byte over its own', { timeout: 120_000 }, async () => {
		const content = new Uint8Array(limit);
		content[0] = 7; content[limit - 1] = 9;
		const hash = await sha256Hex(content);
		expect((await upload(content, { 'X-File-Size': String(limit), 'X-File-Hash': hash })).status).toBe(200);
		expect(await liveFile()).toMatchObject({ hash, size: limit });
		const downloaded = await send('/sync/download?path=attachment.bin');
		expect(await sha256Hex(await downloaded.arrayBuffer())).toBe(hash);
		const over = await send('/sync/upload?path=other.bin', { method: 'PUT', body: 'x',
			headers: { 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)), 'X-Crate-Expected-Hash': 'absent', 'X-File-Size': String(limit + 1) } });
		expect(over.status).toBe(413);
		expect(await over.json()).toEqual({ error: `File exceeds ${formatFileLimit(limit)} limit`, code: 'file_too_large' });
	});
});

it('keeps the default limit and protocol range without the self-hosted binding', async () => {
	const info = await (await request('/.well-known/crate')).json() as { limits: unknown; protocol: unknown; capabilities: string[] };
	expect(info.limits).toEqual({ maxFileBytes: MAX_FILE_SIZE_BYTES, batch: SELF_HOSTED_BATCH_LIMITS });
	// A server at the default, as on Cloudflare, offers no chunked transfers, so clients use one request as before.
	expect(info.capabilities).not.toContain('chunked-uploads-v1');
	expect(info.protocol).toEqual(CRATE_PLUGIN_PROTOCOL);
	const over = await request('/sync/upload?path=attachment.bin', { method: 'PUT', body: 'x',
		headers: { 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)), 'X-Crate-Expected-Hash': 'absent', 'X-File-Size': String(MAX_FILE_SIZE_BYTES + 1) } });
	expect(over.status).toBe(413);
	expect((await request('/sync/upload?path=attachment.bin', { method: 'PUT', body: 'protocol 1',
		headers: { 'X-Crate-Protocol': '1', 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)), 'X-Crate-Expected-Hash': 'absent' } })).status).toBe(200);
});
