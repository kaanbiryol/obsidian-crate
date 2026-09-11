/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256HexBytes } from './auth';
import { writeCommittedMarkdownFile } from './storage';
import { createReminderOperationId } from '../../protocol/reminder-operation';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '../../protocol';

const token = 'protocol-compatibility-test-credential';
beforeEach(async () => {
	for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	await env.DB.prepare('INSERT INTO auth_tokens (id, token_hash, scope) VALUES (?, ?, ?)')
		.bind('protocol-test', await sha256HexBytes(new TextEncoder().encode(token)), 'vault').run();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Note.md', 'Keep the original bytes', null);
});
afterEach(async () => { await reset(); });

function request(path: string, protocol: string | undefined, method = 'GET', body?: string) {
	return new Request(`https://compatibility.test${path}`, { method, body, headers: {
		Authorization: `Bearer ${token}`, ...(protocol === undefined ? {} : { [CRATE_PROTOCOL_HEADER]: protocol }),
	} });
}

describe('old and future clients against the current Worker', () => {
	it.each([undefined, String(CRATE_PLUGIN_PROTOCOL.oldestCompatible - 1), String(CRATE_PLUGIN_PROTOCOL.current + 1), 'invalid'])('refuses incompatible writes before any publication (protocol=%s)', async protocol => {
		const original = await env.DB.prepare('SELECT * FROM files').all();
		for (const [path, method, body] of [
			['/sync/upload?path=Note.md', 'PUT', 'Must not replace bytes'],
			['/sync/delete', 'POST', JSON.stringify({ path: 'Note.md' })],
			['/reminders/create', 'POST', JSON.stringify({ folderPath: 'Reminders', content: 'Must not create' })],
			['/settings', 'PUT', '{}'],
			['/notifications/reminders-exchange', 'POST', '{}'],
		] as const) {
			const response = await worker.fetch(request(path, protocol, method, body), env);
			expect(response.status).toBe(428);
			expect(await response.json()).toMatchObject({ code: 'protocol_incompatible' });
		}
		expect((await env.DB.prepare('SELECT * FROM files').all()).results).toEqual(original.results);
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_operations').first()).toEqual({ count: 0 });
		expect(await env.BUCKET.get('__crate__/settings.json')).toBeNull();
	});
	it('keeps authenticated reads available without granting mutation compatibility', async () => {
		const older = String(CRATE_PLUGIN_PROTOCOL.oldestCompatible - 1);
		const info = await worker.fetch(request('/.well-known/crate', older), env);
		expect(await info.json()).toMatchObject({ protocol: CRATE_PLUGIN_PROTOCOL });
		expect((await worker.fetch(request('/sync/manifest', older), env)).status).toBe(200);
		const download = await worker.fetch(request('/sync/download?path=Note.md', older), env);
		expect(await download.text()).toBe('Keep the original bytes');
		expect((await worker.fetch(request('/sync/metadata', older, 'POST', JSON.stringify({ paths: ['Note.md'] })), env)).status).toBe(200);
		const noAuth = await worker.fetch(new Request('https://compatibility.test/sync/download?path=Note.md'), env);
		expect(noAuth.status).toBe(401);
	});
});

it('accepts protocol-7 upload and reminder receipts on protocol 8, while fencing legacy restores', async () => {
 const body = 'Created by a protocol 7 plugin';
 const upload = request('/sync/upload?path=previous.md', '7', 'PUT', body);
 upload.headers.set('X-Crate-Expected-Hash', 'absent');
 upload.headers.set('X-Crate-Upload-Operation', createReminderOperationId(Math.floor(Date.now() / 86400000)));
 const first = await worker.fetch(upload.clone(), env);
 expect(first.status).toBe(200);
 expect(await (await worker.fetch(upload, env)).json()).toEqual(await first.json());
 const id = createReminderOperationId(Math.floor(Date.now() / 86400000));
 const reminder = JSON.stringify({ id, operationId: id, folderPath: 'Reminders', content: 'Protocol 7 offline reminder' });
 const created = await worker.fetch(request('/reminders/create', '7', 'POST', reminder), env);
 expect(created.status, await created.clone().text()).toBe(200);
 expect(await (await worker.fetch(request('/reminders/create', '7', 'POST', reminder), env)).json()).toEqual(await created.json());
 const before = (await env.DB.prepare('SELECT * FROM files ORDER BY path').all()).results;
 expect((await worker.fetch(request('/sync/restore-version', '7', 'POST', JSON.stringify({ storageKey: 'legacy', expectedHash: null })), env)).status).toBe(428);
 expect((await env.DB.prepare('SELECT * FROM files ORDER BY path').all()).results).toEqual(before);
});
