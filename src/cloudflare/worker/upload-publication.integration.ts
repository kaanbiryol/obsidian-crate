/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol';
import { createReminderOperationId } from '../../protocol/reminder-operation';
import { sha256Hex } from './auth';
import { fetchWorkerRequest } from './request-handler';
import type { Env } from './types';

beforeEach(async () => {
	for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('owner', ?, 'vault')")
		.bind(await sha256Hex('owner')).run();
});
afterEach(reset);

function upload(kind: 'single' | 'batch' | 'bulk', path: string): Request {
	const operationId = createReminderOperationId(Math.floor(Date.now() / 86400000));
	const content = 'staged content';
	return new Request(kind === 'single' ? `https://test/sync/upload?path=${path}` : 'https://test/sync/batch-upload', {
		method: kind === 'single' ? 'PUT' : 'POST',
		headers: { Authorization: 'Bearer owner', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
			'Content-Type': kind === 'single' ? 'application/octet-stream' : 'application/json',
			'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': operationId },
		body: kind === 'single' ? content : JSON.stringify({ bulkNewFiles: kind === 'bulk',
			files: [{ path, operationId, expectedHash: null, content: btoa(content) }] }),
	});
}

function rejectCoordinatorCommits() {
	const forwarded: string[] = [];
	const namespace: Env['REMINDER_ALARMS'] = {
		idFromName: name => env.REMINDER_ALARMS.idFromName(name),
		get: id => ({ fetch: async (input, init) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			if (path === '/commit-upload' || path === '/commit-new-files') {
				forwarded.push(path);
				const body = await request.json() as { objectKey: string } | Array<{ objectKey: string }>;
				for (const file of Array.isArray(body) ? body : [body]) {
					expect(await (await env.BUCKET.get(file.objectKey))?.text()).toBe('staged content');
				}
				return Response.json({ error: 'Coordinator unavailable' }, { status: 503 });
			}
			return env.REMINDER_ALARMS.get(id).fetch(request);
		} }),
	};
	return { runtime: { ...env, REMINDER_ALARMS: namespace }, forwarded };
}

it.each(['single', 'batch', 'bulk'] as const)('keeps a %s Markdown upload staged when its coordinator cannot publish', async kind => {
	const { runtime, forwarded } = rejectCoordinatorCommits();
	const response = await fetchWorkerRequest(upload(kind, 'note.md'), runtime, { kind: 'transfer' });
	expect(response.status, await response.clone().text()).toBe(503);
	expect(forwarded).toEqual([kind === 'bulk' ? '/commit-new-files' : '/commit-upload']);
	expect((await env.BUCKET.list()).objects).toHaveLength(1);
	for (const table of ['files', 'changelog', 'upload_operations']) {
		expect(await env.DB.prepare(`SELECT 1 FROM ${table}`).first(), table).toBeNull();
	}
});

it('publishes binary uploads without requiring the Markdown coordinator', async () => {
	const { runtime, forwarded } = rejectCoordinatorCommits();
	const response = await fetchWorkerRequest(upload('single', 'attachment.bin'), runtime, { kind: 'transfer' });
	expect(response.status, await response.clone().text()).toBe(200);
	expect(forwarded).toEqual([]);
	expect(await env.DB.prepare('SELECT path FROM files').first()).toEqual({ path: 'attachment.bin' });
});

it('confirms coordinator setup once per Worker instance across sync checks', async () => {
	const ensures: string[] = [];
	const namespace: Env['REMINDER_ALARMS'] = {
		idFromName: name => env.REMINDER_ALARMS.idFromName(name),
		get: id => ({ fetch: async (input, init) => {
			const request = new Request(input, init);
			if (new URL(request.url).pathname === '/ensure') ensures.push(request.url);
			return env.REMINDER_ALARMS.get(id).fetch(request);
		} }),
	};
	const runtime = { ...env, REMINDER_ALARMS: namespace };
	for (let poll = 0; poll < 3; poll++) {
		const response = await fetchWorkerRequest(new Request('https://test/sync/check?since=0', {
			headers: { Authorization: 'Bearer owner', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current) },
		}), runtime);
		expect(response.status, await response.clone().text()).toBe(200);
	}
	expect(ensures).toHaveLength(1);
});
