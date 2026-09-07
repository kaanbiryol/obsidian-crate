/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { CRATE_WEB_SESSION_NAME_HEADER } from '../../protocol/web-session';
import { sha256Hex } from './auth';
import { authenticateWorkerRequest } from './authenticate';

beforeEach(async () => {
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { await reset(); });

async function addSession(id: string, scope = 'reminders'): Promise<void> {
	await env.DB.prepare(`INSERT INTO auth_tokens (id, token_hash, device_name, platform, scope, folder_path, last_seen_at)
		VALUES (?, ?, 'iPhone', ?, ?, 'Reminders', datetime('now', '-1 minute'))`)
		.bind(id, await sha256Hex(id), scope === 'reminders' ? 'pwa' : 'ios', scope).run();
}

function request(token: string, encodedName?: string): Request {
	return new Request('https://worker.test/health', { headers: {
		Authorization: `Bearer ${token}`,
		...(encodedName === undefined ? {} : { [CRATE_WEB_SESSION_NAME_HEADER]: encodedName }),
	} });
}

it('refreshes only the authenticated session label without changing its credential or other sessions', async () => {
	await addSession('safari');
	await addSession('home');
	const response = await authenticateWorkerRequest(request('safari', encodeURIComponent('iPhone · Safari')), env.DB);
	expect(response.principal).toMatchObject({ tokenId: 'safari', scope: 'reminders', folderPath: 'Reminders' });
	expect((await env.DB.prepare('SELECT id, device_name FROM auth_tokens ORDER BY id').all()).results).toEqual([
		{ id: 'home', device_name: 'iPhone' }, { id: 'safari', device_name: 'iPhone · Safari' },
	]);
	await authenticateWorkerRequest(request('home', encodeURIComponent('iPhone · Home Screen app')), env.DB);
	expect((await env.DB.prepare('SELECT id, device_name FROM auth_tokens ORDER BY id').all()).results).toEqual([
		{ id: 'home', device_name: 'iPhone · Home Screen app' }, { id: 'safari', device_name: 'iPhone · Safari' },
	]);
	expect((await authenticateWorkerRequest(request('safari'), env.DB)).principal?.tokenId).toBe('safari');
});

it.each([undefined, '', '%invalid', encodeURIComponent('x'.repeat(129)), 'iPhone%0Ainjected'])('preserves the existing label for absent or invalid metadata: %s', async name => {
	await addSession('safari');
	expect((await authenticateWorkerRequest(request('safari', name), env.DB)).principal?.tokenId).toBe('safari');
	expect(await env.DB.prepare('SELECT device_name FROM auth_tokens').first()).toEqual({ device_name: 'iPhone' });
});

it('never renames vault devices from a web session header', async () => {
	await addSession('vault', 'vault');
	expect((await authenticateWorkerRequest(request('vault', encodeURIComponent('iPhone · Safari')), env.DB)).principal?.scope).toBe('vault');
	expect(await env.DB.prepare('SELECT device_name FROM auth_tokens').first()).toEqual({ device_name: 'iPhone' });
});

it('does not write again for the same label within the activity refresh interval', async () => {
	await addSession('safari');
	await env.DB.prepare("UPDATE auth_tokens SET device_name = 'iPhone · Safari'").run();
	const before = await env.DB.prepare('SELECT last_seen_at FROM auth_tokens').first();
	await authenticateWorkerRequest(request('safari', encodeURIComponent('iPhone · Safari')), env.DB);
	expect(await env.DB.prepare('SELECT last_seen_at FROM auth_tokens').first()).toEqual(before);
});

it('does not rename anything for an invalid credential', async () => {
	await addSession('safari');
	expect((await authenticateWorkerRequest(request('invalid', encodeURIComponent('iPhone · Safari')), env.DB)).response?.status).toBe(401);
	expect(await env.DB.prepare('SELECT device_name FROM auth_tokens').first()).toEqual({ device_name: 'iPhone' });
});
