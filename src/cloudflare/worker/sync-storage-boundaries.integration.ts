/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex, sha256HexBytes } from './auth';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol';
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';

beforeEach(async () => {
	vi.spyOn(console, 'info').mockImplementation(() => {});
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
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
		const hash = await sha256HexBytes(content);
		const uploaded = await request('/sync/upload?path=attachment.bin', { method: 'PUT', body: content,
			headers: { 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)), 'X-Crate-Expected-Hash': 'absent', 'X-File-Size': String(content.length), 'X-File-Hash': hash } });
		expect(uploaded.status).toBe(200);
		expect(await liveFile()).toMatchObject({ hash, size: MAX_FILE_SIZE_BYTES });
		const downloaded = await request('/sync/download?path=attachment.bin');
		expect(downloaded.status).toBe(200);
		const body = await downloaded.arrayBuffer();
		expect(body.byteLength).toBe(MAX_FILE_SIZE_BYTES);
		expect(await sha256HexBytes(body)).toBe(hash);
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
