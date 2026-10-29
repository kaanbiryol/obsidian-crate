/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { READING_SHORTCUT_CONTRACT as contract } from '@/reading/shortcut';
import { sha256Hex } from '@/platform/sha256';

beforeEach(async () => {
	await applySchema(env.DB);
	const expires = Date.now() + 86400_000;
	await env.DB.batch([
		env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,1,'Reading','policy','revision')"),
		env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope) VALUES ('owner',?,'vault')").bind(await sha256Hex('owner')),
		...await Promise.all(['browser', 'other'].map(async id => env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope,folder_path,expires_at) VALUES (?,?,'reminders','Reminders',?)")
			.bind(id, await sha256Hex(id), expires))),
	]);
});
afterEach(async () => { await reset(); });

const call = (path: string, init: { method?: string; bearer?: string; body?: unknown; headers?: Record<string, string> }) => worker.fetch(new Request(`https://test${path}`, {
	method: init.method ?? 'POST', body: init.body === undefined ? undefined : JSON.stringify(init.body),
	headers: { 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}), ...init.headers },
}), { ...env, NOTIFICATION_REQUEST_LIMITER: { limit: async () => ({ success: true }) } });

/** Pair a Shortcut from `issuer`, as the Reading settings and the Shortcut do. */
async function pair(issuer: string): Promise<string> {
	const pairing = await call('/reading/shortcut-pairing', { bearer: issuer, body: {} });
	expect(pairing.status, await pairing.clone().text()).toBe(200);
	const { pairingCode } = await pairing.json() as { pairingCode: string };
	const exchange = await call(contract.exchangePath, { body: { token: new URL(pairingCode).hash.slice(1) }, headers: { [contract.revisionHeader]: String(contract.revision) } });
	expect(exchange.status, await exchange.clone().text()).toBe(200);
	return ((await exchange.json()) as { authorization: string }).authorization.slice('Bearer '.length);
}
const save = (capture: string) => call(contract.preparePath, { bearer: capture, body: { url: 'https://example.com/article' }, headers: { [contract.revisionHeader]: String(contract.revision) } });
const captures = async () => (await env.DB.prepare("SELECT device_id FROM auth_tokens WHERE scope='reading_capture' ORDER BY device_id").all<{ device_id: string }>()).results.map(row => row.device_id);

it('revokes the Shortcut credentials a device paired when that device is removed', async () => {
	const stolen = await pair('browser'), kept = await pair('other');
	expect((await save(stolen)).status).toBe(200);
	expect((await call('/auth/tokens', { method: 'DELETE', bearer: 'owner', body: { id: 'browser' } })).status).toBe(200);
	expect((await save(stolen)).status).toBe(401);
	expect((await save(kept)).status).toBe(200);
	expect(await captures()).toEqual(['other']);
});

it('revokes the Shortcut credentials a session paired when it signs out', async () => {
	const capture = await pair('browser');
	expect((await call('/auth/session', { method: 'DELETE', bearer: 'browser' })).status).toBe(200);
	expect((await save(capture)).status).toBe(401);
	expect(await captures()).toEqual([]);
});

it('moves Shortcut credentials to the session that replaces their web app session', async () => {
	const capture = await pair('browser');
	await env.DB.prepare("INSERT INTO web_enrollment_tokens(token_hash,expires_at,folder_path) VALUES (?,?,'Reminders')").bind(await sha256Hex('link'), Date.now() + 60_000).run();
	const exchange = await call('/notifications/reminders-exchange', { body: { token: 'link', previousAuthToken: 'browser' } });
	expect(exchange.status).toBe(200);
	const { authToken } = await exchange.json() as { authToken: string };
	const replacement = await env.DB.prepare('SELECT id FROM auth_tokens WHERE token_hash=?').bind(await sha256Hex(authToken)).first<{ id: string }>();
	expect(await env.DB.prepare("SELECT 1 FROM auth_tokens WHERE id='browser'").first()).toBeNull();
	expect(await captures()).toEqual([replacement!.id]);
	expect((await save(capture)).status).toBe(200);
	// The replacement now owns it: logging out revokes it.
	expect((await call('/auth/session', { method: 'DELETE', bearer: authToken })).status).toBe(200);
	expect((await save(capture)).status).toBe(401);
	expect(await captures()).toEqual([]);
});

it('lists a Shortcut credential by name without exposing its issuer', async () => {
	await pair('browser');
	const response = await call('/auth/tokens', { method: 'GET', bearer: 'owner' });
	const { tokens } = await response.json() as { tokens: Array<{ device_id: string | null; device_name: string; platform: string }> };
	expect(tokens.find(token => token.platform === 'shortcut')).toMatchObject({ device_id: null, device_name: 'Save to Crate shortcut' });
});
