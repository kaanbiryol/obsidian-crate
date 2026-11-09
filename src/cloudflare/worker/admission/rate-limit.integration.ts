/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '../../../protocol/server-info';
import { admitApiRequest, chargeRouteAction } from './rate-limit';
import { sha256Hex } from '../../../platform/sha256';
beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const request = (path = 'test') => new Request(`https://test/notifications/${path}`, { method: 'POST' });
it('rejects arbitrary routes and edge-denied traffic without touching D1', async () => {
	const prepare = vi.spyOn(env.DB, 'prepare');
	const edge = { limit: vi.fn(async () => ({ success: false })) };
	for (let index = 0; index < 100; index++) expect((await admitApiRequest(request(`unknown-${index}`), env.DB, edge))?.status).toBe(404);
	expect(edge.limit).not.toHaveBeenCalled();
	for (let index = 0; index < 100; index++) expect((await admitApiRequest(request(), env.DB, edge))?.status).toBe(429);
	expect(prepare).not.toHaveBeenCalled();
});
it('stops incrementing per-action counters for denied requests and resets an expired window', async () => {
		for (let index = 0; index < 3; index++) expect(await chargeRouteAction(request(), env.DB, 'actor')).toBeNull();
	for (let index = 0; index < 100; index++) expect((await chargeRouteAction(request(), env.DB, 'actor'))?.status).toBe(429);
	expect(await env.DB.prepare("SELECT count FROM request_rate_limits WHERE key NOT LIKE 'notification-daily:%'").first()).toEqual({ count: 3 });
	expect(await env.DB.prepare("SELECT count FROM request_rate_limits WHERE key = ?").bind(await dailyKey('actor')).first()).toEqual({ count: 3 });
	await env.DB.prepare('UPDATE request_rate_limits SET expires_at = 0').run();
	expect(await chargeRouteAction(request(), env.DB, 'actor')).toBeNull();
	expect(await env.DB.prepare("SELECT count FROM request_rate_limits WHERE key NOT LIKE 'notification-daily:%'").first()).toEqual({ count: 1 });
});

const dailyKey = async (actor: string) => `notification-daily:${await sha256Hex(actor)}`;
const exhaust = async (actor: string, count = 999) => env.DB.prepare('INSERT INTO request_rate_limits(key,count,expires_at) VALUES (?,?,?)')
	.bind(await dailyKey(actor), count, Date.now() + 86400000).run();

it('caps daily admissions across rotating addresses without growing or updating denied counters', async () => {
	await exhaust('actor');
	expect(await chargeRouteAction(request(), env.DB, 'actor')).toBeNull();
	const rows = (await env.DB.prepare('SELECT * FROM request_rate_limits ORDER BY key').all()).results;
	for (let index = 0; index < 100; index++) {
		const attempt = request(); attempt.headers.set('CF-Connecting-IP', `192.0.2.${index}`);
		const denied = await chargeRouteAction(attempt, env.DB, 'actor');
		expect(denied?.status).toBe(429);
		expect(Number(denied?.headers.get('Retry-After'))).toBeGreaterThan(60);
	}
	expect((await env.DB.prepare('SELECT * FROM request_rate_limits ORDER BY key').all()).results).toEqual(rows);
});

it('one credential cannot spend the daily budget of any other credential', async () => {
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope) VALUES ('owner',?,'vault')").bind(await sha256Hex('owner')).run();
	// A reminders token alternates subscribe and unsubscribe. Each minute's per-action
	// windows are cleared, as they expire, until its daily budget runs out.
	const windows = await Promise.all(['POST', 'DELETE'].map(method => sha256Hex(`stolen\0${method} /notifications/subscribe`)));
	const subscribe = (method: string) => new Request('https://test/notifications/subscribe', { method });
	let admitted = 0;
	for (let minute = 0; ; minute++) {
		let denied: Response | null = null;
		for (let index = 0; index < 60 && !denied; index++) {
			denied = await chargeRouteAction(subscribe(index % 2 ? 'DELETE' : 'POST'), env.DB, 'stolen');
			if (!denied) admitted++;
		}
		if (denied) { expect(await denied.json()).toMatchObject({ error: expect.stringContaining('daily') as string }); break; }
		await env.DB.prepare('DELETE FROM request_rate_limits WHERE key IN (?, ?)').bind(...windows).run();
		expect(minute).toBeLessThan(20);
	}
	expect(admitted).toBe(1000);
	// Other web app sessions and the vault's administration keep their own budgets.
	expect(await chargeRouteAction(subscribe('POST'), env.DB, 'other')).toBeNull();
	const post = (path: string, body: unknown) => worker.fetch(new Request(`https://test${path}`, {
		method: 'POST', headers: { Authorization: 'Bearer owner', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
	}), { ...env, NOTIFICATION_REQUEST_LIMITER: { limit: async () => ({ success: true }) } });
	expect((await post('/features', { feature: 'reading', enabled: true, revision: null })).status).toBe(200);
	expect((await post('/notifications/reminders-enrollment-token', { folderPath: 'Reminders' })).status).toBe(200);
});

it('invalid bearers and enrollment grants cannot spend authenticated capacity', async () => {
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope) VALUES ('owner',?,'vault')").bind(await sha256Hex('owner')).run();
	await exhaust('owner');
	const post = (path: string, token: string, body: unknown) => worker.fetch(new Request(`https://test${path}`, {
		method:'POST', headers: {Authorization:`Bearer ${token}`, [CRATE_PROTOCOL_HEADER]:String(CRATE_PLUGIN_PROTOCOL.current),'Content-Type':'application/json'}, body:JSON.stringify(body),
	}), { ...env, NOTIFICATION_REQUEST_LIMITER: { limit: async () => ({success:true}) } });
	for (let i=0;i<5;i++) {
		expect((await post('/notifications/subscribe',`invalid-${i}`,{})).status).toBe(401);
		expect((await post('/notifications/reminders-exchange','',{token:`invalid-${i}`})).status).toBe(401);
	}
	expect((await env.DB.prepare('SELECT key, count FROM request_rate_limits').all()).results).toEqual([{ key: await dailyKey('owner'), count: 999 }]);
	expect((await post('/notifications/reminders-enrollment-token','owner',{folderPath:'Reminders'})).status).toBe(200);
});

it('an exhausted exchange budget cannot deny an authenticated management action', async () => {
	await env.DB.prepare("INSERT INTO request_rate_limits(key,count,expires_at) VALUES ('notification-exchange-daily',1000,?)").bind(Date.now()+86400000).run();
	expect(await chargeRouteAction(request('reminders-enrollment-token'),env.DB,'owner')).toBeNull();
});

it('edge keys separate senders without placing raw addresses in the key', async () => {
	const edge = {limit: vi.fn(async () => ({success:true}))};
	for (const address of ['192.0.2.1','192.0.2.2']) {
		const attempt=request(); attempt.headers.set('CF-Connecting-IP',address);
		expect(await admitApiRequest(attempt,env.DB,edge)).toBeNull();
	}
	expect(edge.limit.mock.calls[0]).not.toEqual(edge.limit.mock.calls[1]);
	expect(JSON.stringify(edge.limit.mock.calls)).not.toContain('192.0.2.');
});

it.each(['/sync/manifest', '/sync/changes', '/reminders/list', '/reading/items', '/features', '/diagnostics', '/notifications/vapid-public-key'])('denies %s before D1 or Durable Objects', async path => {
	const prepare = vi.spyOn(env.DB, 'prepare');
	const get = vi.fn(() => { throw new Error('Coordinator must not be reached'); });
	const response = await worker.fetch(new Request(`https://denied.test${path}`, { headers: { Authorization: 'Bearer invalid' } }), {
		...env, NOTIFICATION_REQUEST_LIMITER: { limit: async () => ({ success: false }) }, REMINDER_ALARMS: { ...env.REMINDER_ALARMS, get },
	});
	expect(response.status).toBe(429);
	expect(response.headers.get('Retry-After')).toBe('60');
	expect(prepare).not.toHaveBeenCalled();
	expect(get).not.toHaveBeenCalled();
});

it('keeps fallback budgets across real request-local metering wrappers and rotating bearers', async () => {
	const statuses = [];
	for (let index = 0; index < 80; index++) statuses.push((await worker.fetch(new Request('https://fallback.test/sync/manifest', {
		headers: { Authorization: `Bearer invalid-${index}` },
	}), { ...env, NOTIFICATION_REQUEST_LIMITER: undefined })).status);
	expect(statuses.slice(0, 60)).toEqual(Array(60).fill(401));
	expect(statuses.slice(60)).toEqual(Array(20).fill(429));
	const prepare = vi.spyOn(env.DB, 'prepare');
	expect((await worker.fetch(new Request('https://fallback.test/features'), { ...env, NOTIFICATION_REQUEST_LIMITER: undefined })).status).toBe(429);
	expect(prepare).not.toHaveBeenCalled();
});

it('authenticates an unrecognized bearer at the edge, a recognized one only inside the coordinator, and remembers its answer for admission', async () => {
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope) VALUES ('owner',?,'vault')").bind(await sha256Hex('owner')).run();
	await env.DB.prepare("INSERT INTO reading_policy(id, enabled, folder_path, generation, revision) VALUES (1, 0, 'Reading', 'g', 'r')").run();
	const edgeStatements: string[] = [];
	const edgeDb = new Proxy(env.DB, { get(target, key) {
		if (key === 'prepare') return (sql: string) => { edgeStatements.push(sql); return target.prepare(sql); };
		const value: unknown = Reflect.get(target, key);
		return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
	} });
	const limit = vi.fn(async () => ({ success: true }));
	// A reset status read is a coordinator read; it rejects this malformed reset ID after authenticating.
	const attempt = (token: string) => worker.fetch(new Request('https://once.test/encryption/reset', { headers: { Authorization: `Bearer ${token}` } }),
		{ ...env, DB: edgeDb, NOTIFICATION_REQUEST_LIMITER: { limit } });
	const edgeAuthentications = () => edgeStatements.filter(sql => sql.includes('FROM auth_tokens')).length;
	// An unrecognized bearer authenticates at the edge, so an invalid one never queues on the coordinator lock.
	expect((await attempt('invalid')).status).toBe(401);
	expect(limit).toHaveBeenCalledTimes(1);
	expect(edgeAuthentications()).toBe(1);
	for (let index = 0; index < 3; index++) expect((await attempt('owner')).status).toBe(400);
	// The first accepted answer admits the credential to the authenticated budget,
	// and later requests authenticate only inside the coordinator.
	expect(limit).toHaveBeenCalledTimes(2);
	expect(edgeAuthentications()).toBe(2);
	await env.DB.prepare("DELETE FROM auth_tokens WHERE id='owner'").run();
	expect((await attempt('owner')).status).toBe(401);
	expect(edgeAuthentications()).toBe(2);
	// The coordinator's rejection removed the hint, so the edge checks the bearer again.
	expect((await attempt('owner')).status).toBe(401);
	expect(limit).toHaveBeenCalledTimes(3);
	expect(edgeAuthentications()).toBe(3);
});

it.each(['/reading/shortcut/v1/prepare', '/reading/shortcut/v1/exchange'])('returns a safe launch page when %s is denied at the edge', async path => {
	const prepare = vi.spyOn(env.DB, 'prepare');
	const response = await worker.fetch(new Request(`https://denied.test${path}`, { method: 'POST',
		headers: { Authorization: 'Bearer private-credential', 'X-Crate-Shortcut-Revision': '2' },
		body: JSON.stringify({ url: 'https://example.com/private-article', token: 'private-pairing-code' }),
	}), { ...env, NOTIFICATION_REQUEST_LIMITER: { limit: async () => ({ success: false }) } });
	expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60');
	const result = await response.json() as { launchUrl: string };
	expect(result.launchUrl).toMatch(/^https:\/\/denied\.test\/notifications\/save-reading#error=/);
	expect(decodeURIComponent(result.launchUrl)).not.toContain('private');
	expect(prepare).not.toHaveBeenCalled();
});

it('rejects unknown routes and methods before protocol checks, authentication, or admission', async () => {
	const prepare = vi.spyOn(env.DB, 'prepare');
	const limit = vi.fn(async () => ({ success: false }));
	for (const [method, path] of [['GET', '/sync/invented'], ['POST', '/reading/invented'], ['PATCH', '/features'], ['POST', '/health']]) {
		const response = await worker.fetch(new Request(`https://unknown.test${path}`, { method, headers: { Authorization: 'Bearer invalid' } }), { ...env, NOTIFICATION_REQUEST_LIMITER: { limit } });
		expect(response.status).toBe(404);
	}
	expect(prepare).not.toHaveBeenCalled();
	expect(limit).not.toHaveBeenCalled();
});

it('separates authenticated sync traffic and still honors immediate token revocation', async () => {
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope) VALUES ('bootstrap-owner',?,'vault')").bind(await sha256Hex('bootstrap-owner')).run();
	const limit = vi.fn(async () => ({ success: true }));
	const attempt = () => worker.fetch(new Request('https://bootstrap.test/health', { headers: { Authorization: 'Bearer bootstrap-owner' } }), { ...env, NOTIFICATION_REQUEST_LIMITER: { limit } });
	for (let index = 0; index < 100; index++) expect((await attempt()).status).toBe(200);
	expect(limit).toHaveBeenCalledTimes(1);
	await env.DB.prepare("DELETE FROM auth_tokens WHERE id='bootstrap-owner'").run();
	expect((await attempt()).status).toBe(401);
	expect((await attempt()).status).toBe(401);
	expect(limit).toHaveBeenCalledTimes(2);
});
