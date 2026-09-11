/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { limitNotificationRequest, limitNotificationAction } from './rate-limit';
beforeEach(async () => { for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const request = (path = 'test') => new Request(`https://test/notifications/${path}`, { method: 'POST' });
it('rejects arbitrary routes and edge-denied traffic without touching D1', async () => {
	const prepare = vi.spyOn(env.DB, 'prepare');
	const edge = { limit: vi.fn(async () => ({ success: false })) };
	for (let index = 0; index < 100; index++) expect((await limitNotificationRequest(request(`unknown-${index}`), env.DB, edge))?.status).toBe(404);
	expect(edge.limit).not.toHaveBeenCalled();
	for (let index = 0; index < 100; index++) expect((await limitNotificationRequest(request(), env.DB, edge))?.status).toBe(429);
	expect(prepare).not.toHaveBeenCalled();
});
it('stops incrementing per-action counters for denied requests and resets an expired window', async () => {
		for (let index = 0; index < 3; index++) expect(await limitNotificationAction(request(), env.DB, 'actor')).toBeNull();
	for (let index = 0; index < 100; index++) expect((await limitNotificationAction(request(), env.DB, 'actor'))?.status).toBe(429);
	expect(await env.DB.prepare("SELECT count FROM request_rate_limits WHERE key != 'notification-daily'").first()).toEqual({ count: 3 });
	expect(await env.DB.prepare("SELECT count FROM request_rate_limits WHERE key = 'notification-daily'").first()).toEqual({ count: 3 });
	await env.DB.prepare('UPDATE request_rate_limits SET expires_at = 0').run();
	expect(await limitNotificationAction(request(), env.DB, 'actor')).toBeNull();
	expect(await env.DB.prepare("SELECT count FROM request_rate_limits WHERE key != 'notification-daily'").first()).toEqual({ count: 1 });
});


it('caps daily admissions across rotating addresses without growing or updating denied counters', async () => {
		await env.DB.prepare("INSERT INTO request_rate_limits(key,count,expires_at) VALUES('notification-daily', 999, ?)").bind(Date.now() + 86400000).run();
	expect(await limitNotificationAction(request(), env.DB, 'actor')).toBeNull();
	const rows = (await env.DB.prepare('SELECT * FROM request_rate_limits ORDER BY key').all()).results;
	for (let index = 0; index < 100; index++) {
		const attempt = request(); attempt.headers.set('CF-Connecting-IP', `192.0.2.${index}`);
		expect((await limitNotificationAction(attempt, env.DB, `actor-${index}`))?.status).toBe(429);
	}
	expect((await env.DB.prepare('SELECT * FROM request_rate_limits ORDER BY key').all()).results).toEqual(rows);
});

it('invalid bearers and enrollment grants cannot spend authenticated capacity', async () => {
	const { default: worker } = await import('./index');
	const { sha256Hex } = await import('./auth');
	const { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } = await import('../../protocol');
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope) VALUES ('owner',?,'vault')").bind(await sha256Hex('owner')).run();
	await env.DB.prepare("INSERT INTO request_rate_limits(key,count,expires_at) VALUES ('notification-daily',999,?)").bind(Date.now()+86400000).run();
	const post = (path: string, token: string, body: unknown) => worker.fetch(new Request(`https://test${path}`, {
		method:'POST', headers: {Authorization:`Bearer ${token}`, [CRATE_PROTOCOL_HEADER]:String(CRATE_PLUGIN_PROTOCOL.current),'Content-Type':'application/json'}, body:JSON.stringify(body),
	}), { ...env, NOTIFICATION_REQUEST_LIMITER: { limit: async () => ({success:true}) } });
	for (let i=0;i<5;i++) {
		expect((await post('/notifications/subscribe',`invalid-${i}`,{})).status).toBe(401);
		expect((await post('/notifications/reminders-exchange','',{token:`invalid-${i}`})).status).toBe(401);
	}
	expect(await env.DB.prepare("SELECT count FROM request_rate_limits WHERE key='notification-daily'").first()).toEqual({count:999});
	expect((await post('/notifications/reminders-enrollment-token','owner',{folderPath:'Reminders'})).status).toBe(200);
});

it('an exhausted exchange budget cannot deny an authenticated management action', async () => {
	await env.DB.prepare("INSERT INTO request_rate_limits(key,count,expires_at) VALUES ('notification-exchange-daily',1000,?)").bind(Date.now()+86400000).run();
	expect(await limitNotificationAction(request('reminders-enrollment-token'),env.DB,'owner')).toBeNull();
});

it('edge keys separate senders without placing raw addresses in the key', async () => {
	const edge = {limit: vi.fn(async () => ({success:true}))};
	for (const address of ['192.0.2.1','192.0.2.2']) {
		const attempt=request(); attempt.headers.set('CF-Connecting-IP',address);
		expect(await limitNotificationRequest(attempt,env.DB,edge)).toBeNull();
	}
	expect(edge.limit.mock.calls[0]).not.toEqual(edge.limit.mock.calls[1]);
	expect(JSON.stringify(edge.limit.mock.calls)).not.toContain('192.0.2.');
});
