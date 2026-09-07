/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex } from './auth';
import { issueWebEnrollmentToken } from './web-enrollment';

beforeEach(async () => { for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { await reset(); });

const endpoint = 'https://fcm.googleapis.com/fcm/send/reconcile';
const subscription = { endpoint, keys: { p256dh: 'key', auth: 'auth' }, deviceName: 'Browser' };
function request(path: string, token: string, body: unknown, method = 'POST') {
	return new Request(`https://test${path}`, { method, headers: {
		Authorization: `Bearer ${token}`, 'X-Crate-Protocol': '5', 'Content-Type': 'application/json',
	}, body: JSON.stringify(body) });
}
async function issueToken(id: string, folder = 'Reminders') {
	await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope, folder_path, expires_at) VALUES (?, ?, 'reminders', ?, ?)")
		.bind(id, await sha256Hex(id), folder, Date.now() + 60_000).run();
	return id;
}
const attach = (token: string) => worker.fetch(request('/notifications/subscribe', token, subscription), env);

it('confirms retry and repair with the same recipient identity after a committed response is lost', async () => {
	const token = await issueToken('browser');
	expect((await attach(token)).status).toBe(200); // The client never receives this successful response.
	const original = await env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first<{ id: string }>();
	await env.DB.prepare("UPDATE push_subscriptions SET disabled_at = 1, last_error = 'provider failure'").run();
	const confirmation = await attach(token);
	expect(confirmation.status).toBe(200);
	expect(await confirmation.json()).toEqual({ id: original!.id });
	expect(await env.DB.prepare('SELECT id, owner_token_id, folder_path, disabled_at, last_error FROM push_subscriptions').all())
		.toMatchObject({ results: [{ id: original!.id, owner_token_id: 'browser', folder_path: 'Reminders', disabled_at: null, last_error: null }] });
	await env.DB.prepare('DELETE FROM push_subscriptions').run();
	expect((await attach(token)).status).toBe(200);
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').first()).toEqual({ count: 1 });
});

it('reattaches a retained browser endpoint to the renewed authenticated folder after enrollment revokes its old owner', async () => {
	const old = await issueToken('old-browser');
	expect((await attach(old)).status).toBe(200);
	const enrollment = await issueWebEnrollmentToken(env.DB, 'Private');
	const response = await worker.fetch(request('/notifications/reminders-exchange', '', { token: enrollment.token, previousAuthToken: old }), env);
	expect(response.status).toBe(200);
	const { authToken } = await response.json() as { authToken: string };
	expect(await env.DB.prepare('SELECT id FROM push_subscriptions').first()).toBeNull();
	expect((await attach(old)).status).toBe(401);
	expect((await attach(authToken)).status).toBe(200);
	const owner = await env.DB.prepare('SELECT id FROM auth_tokens WHERE token_hash = ?').bind(await sha256Hex(authToken)).first<{ id: string }>();
	expect(await env.DB.prepare('SELECT owner_token_id, folder_path FROM push_subscriptions').first()).toEqual({ owner_token_id: owner!.id, folder_path: 'Private' });
});

it('cannot confirm another current owner’s endpoint or register with expired authority', async () => {
	await issueToken('owner'); await issueToken('other', 'Private');
	expect((await attach('owner')).status).toBe(200);
	const before = await env.DB.prepare('SELECT * FROM push_subscriptions').first();
	expect((await attach('other')).status).toBe(429);
	expect(await env.DB.prepare('SELECT * FROM push_subscriptions').first()).toEqual(before);
	await env.DB.prepare("UPDATE auth_tokens SET expires_at = 1 WHERE id = 'owner'").run();
	expect((await attach('owner')).status).toBe(401);
	expect(await env.DB.prepare('SELECT * FROM push_subscriptions').first()).toEqual(before);
});
