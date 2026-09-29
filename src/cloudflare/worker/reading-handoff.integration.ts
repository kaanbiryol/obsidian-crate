/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { sha256Hex } from './auth';
import { fetchWorkerRequest } from './request-handler';

beforeEach(async () => {
	await env.DB.batch(schema.split(';').map(value => value.trim()).filter(Boolean).map(value => env.DB.prepare(value)));
	await env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,0,'Reading','g','r')").run();
});
afterEach(reset);

async function prepare(scope: string) {
	const token = `handoff-${scope}`;
	await env.DB.prepare('INSERT INTO auth_tokens(id,token_hash,scope,folder_path,reading_generation,expires_at) VALUES (?,?,?,?,?,?)')
		.bind('issuer', await sha256Hex(token), scope, scope === 'reminders' ? 'Reminders' : 'Reading', 'g', Date.now() + 60_000).run();
	const response = await fetchWorkerRequest(new Request('https://crate.example/reading/prepare', {
		method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Crate-Protocol': '1', 'Content-Type': 'application/json' },
		body: JSON.stringify({ url: 'https://example.invalid/handoff', title: 'Saved by handoff' }),
	}), env);
	expect(response.status, await response.clone().text()).toBe(200);
	return new URL((await response.json() as { launchUrl: string }).launchUrl).hash.slice(1);
}
const redeem = (token: string) => fetchWorkerRequest(new Request('https://crate.example/reading/handoff', {
	method: 'POST', headers: { 'X-Crate-Capture': token, 'X-Crate-Protocol': '1', 'Content-Type': 'application/json' }, body: '{}',
}), env);

it.each(['vault', 'reminders', 'reading', 'reading_capture'])('redeems and replays a handoff prepared by %s exactly once', async scope => {
	const token = await prepare(scope);
	const response = await redeem(token);
	expect(response.status, await response.clone().text()).toBe(200);
	const result: unknown = await response.json();
	expect(result).toMatchObject({ saved: true });
	const replay = await redeem(token);
	expect(replay.status).toBe(200);
	expect(await replay.json()).toEqual(result);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM files').first()).toEqual({ n: 1 });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM changelog').first()).toEqual({ n: 1 });
});

it.each([
	['revoked issuer', "DELETE FROM auth_tokens WHERE id='issuer'", 410],
	['expired issuer', "UPDATE auth_tokens SET expires_at=1 WHERE id='issuer'", 410],
	['expired capability', 'UPDATE reading_handoffs SET expires_at=1', 410],
	['changed generation', "UPDATE reading_policy SET generation='new'", 410],
	['paused Reading', `INSERT INTO maintenance_state(key,value) VALUES ('crate_feature_policy','{"reading":false,"reminders":true,"revision":"r"}')`, 423],
] as const)('rejects reminder handoffs after %s without writing a note', async (_name, sql, status) => {
	const token = await prepare('reminders');
	await env.DB.prepare(sql).run();
	const response = await redeem(token);
	expect(response.status, await response.clone().text()).toBe(status);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM files').first()).toEqual({ n: 0 });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM changelog').first()).toEqual({ n: 0 });
});

it('rejects even a previously committed handoff after its issuer is revoked', async () => {
	const token = await prepare('reminders');
	expect((await redeem(token)).status).toBe(200);
	await env.DB.prepare("DELETE FROM auth_tokens WHERE id='issuer'").run();
	expect((await redeem(token)).status).toBe(410);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM files').first()).toEqual({ n: 1 });
});
