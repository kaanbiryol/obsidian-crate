/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { limitNotificationRequest } from './rate-limit';
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
	const edge = { limit: async () => ({ success: true }) };
	for (let index = 0; index < 3; index++) expect(await limitNotificationRequest(request(), env.DB, edge)).toBeNull();
	for (let index = 0; index < 100; index++) expect((await limitNotificationRequest(request(), env.DB, edge))?.status).toBe(429);
	expect(await env.DB.prepare("SELECT count FROM request_rate_limits WHERE key != 'notification-daily'").first()).toEqual({ count: 3 });
	await env.DB.prepare('UPDATE request_rate_limits SET expires_at = 0').run();
	expect(await limitNotificationRequest(request(), env.DB, edge)).toBeNull();
	expect(await env.DB.prepare("SELECT count FROM request_rate_limits WHERE key != 'notification-daily'").first()).toEqual({ count: 1 });
});


it('caps daily admissions across rotating addresses without growing or updating denied counters', async () => {
	const edge = { limit: async () => ({ success: true }) };
	await env.DB.prepare("INSERT INTO request_rate_limits(key,count,expires_at) VALUES('notification-daily', 999, ?)").bind(Date.now() + 86400000).run();
	expect(await limitNotificationRequest(request(), env.DB, edge)).toBeNull();
	const rows = (await env.DB.prepare('SELECT * FROM request_rate_limits ORDER BY key').all()).results;
	for (let index = 0; index < 100; index++) {
		const attempt = request(); attempt.headers.set('CF-Connecting-IP', `192.0.2.${index}`);
		expect((await limitNotificationRequest(attempt, env.DB, edge))?.status).toBe(429);
	}
	expect((await env.DB.prepare('SELECT * FROM request_rate_limits ORDER BY key').all()).results).toEqual(rows);
});
