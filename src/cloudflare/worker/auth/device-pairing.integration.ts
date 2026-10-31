/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { exchangeDevicePairing } from './device-pairing';
import { issueDevicePairingCode } from '../../deployment/device-pairing';
import type { CloudflareDeploymentMetadata } from '../../deployment/types';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '../../../protocol/server-info';
import { DEVICE_PAIRING_PAGE, DEVICE_PAIRING_PATH } from '../../../protocol/device-pairing';
import { sha256Hex } from '../../../platform/sha256';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { await reset(); });

const metadata: CloudflareDeploymentMetadata = {
	deploymentId: '0123456789abcdef', accountId: 'a'.repeat(32), accountName: 'Personal', workerName: 'crate-0123456789abcdef',
	d1DatabaseName: 'crate-0123456789abcdef', d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef', r2BucketName: 'crate-0123456789abcdef',
	workersSubdomain: 'example', lastDeployedVersion: '0.9.0', lastDeployedFingerprint: null,
	deletion: { id: 'b'.repeat(32), phase: 'removing-worker', databaseId: 'x', bucketCreatedAt: null, workerCreatedAt: null, helperName: 'helper' },
};
// Runs the desktop's Cloudflare D1 API statements against the test database.
const api = { queryD1: async (_account: string, _database: string, sql: string, params: string[] = []) => [{ results: (await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>()).results }] };
const issue = (now = Date.now()) => issueDevicePairingCode({ api, accountId: 'account', databaseId: 'database', metadata, now });
const device = async (token: string, deviceId = 'phone') => ({ tokenHash: await sha256Hex(token), deviceId, deviceName: 'iPhone', platform: 'ios' });
const exchange = async (code: string, body: Awaited<ReturnType<typeof device>>) =>
	exchangeDevicePairing(new Request('https://test/auth/device-pairing', { method: 'POST', body: JSON.stringify({ code, ...body }) }), env.DB);
const vaultTokens = async () => (await env.DB.prepare("SELECT id, device_id FROM auth_tokens WHERE scope = 'vault' ORDER BY id").all()).results;

it('redeems a code once for a vault token and the server identity, and repeats the result for a lost response', async () => {
	const issued = await issue();
	const stored = JSON.stringify((await env.DB.prepare('SELECT key, value FROM maintenance_state').all()).results);
	expect(stored).not.toContain(issued.code);
	const phone = await device('phone-token');
	const first = await exchange(issued.code, phone);
	expect(first.status).toBe(200);
	const result = await first.json() as { tokenId: string; deployment: Record<string, unknown> };
	expect(result.tokenId).toBe(issued.tokenId);
	expect(result.deployment).toMatchObject({ workerName: metadata.workerName, accountId: metadata.accountId });
	expect(result.deployment).not.toHaveProperty('deletion');
	expect(await env.DB.prepare('SELECT id, scope, device_id, device_name FROM auth_tokens WHERE token_hash = ?').bind(phone.tokenHash).first())
		.toEqual({ id: issued.tokenId, scope: 'vault', device_id: 'phone', device_name: 'iPhone' });
	expect((await exchange(issued.code, phone)).status).toBe(200);
	expect((await exchange(issued.code, await device('attacker-token'))).status).toBe(410);
	expect(await vaultTokens()).toHaveLength(1);
});

it('allows only one of concurrent redemptions', async () => {
	const issued = await issue();
	const results = await Promise.all(['a', 'b', 'c', 'd'].map(async token => (await exchange(issued.code, await device(token, token))).status));
	expect(results.filter(status => status === 200)).toHaveLength(1);
	expect(await vaultTokens()).toHaveLength(1);
});

it.each(['expired', 'replaced', 'reset', 'malformed'])('rejects a %s code without creating a credential', async reason => {
	const issued = await issue(reason === 'expired' ? Date.now() - 11 * 60_000 : Date.now());
	if (reason === 'replaced') await issue();
	if (reason === 'reset') await env.DB.prepare("INSERT INTO server_state (id, reset_generation) VALUES (1, 'after-reset') ON CONFLICT(id) DO UPDATE SET reset_generation = excluded.reset_generation").run();
	const response = await exchange(reason === 'malformed' ? 'not-a-code' : issued.code, await device('phone-token'));
	expect(response.status).toBe(reason === 'malformed' ? 400 : 410);
	expect(await vaultTokens()).toEqual([]);
});

it('replaces only the re-paired device credential and what it owned', async () => {
	for (const [id, deviceId, scope] of [['old-phone', 'phone', 'vault'], ['desktop', 'desktop', 'vault'], ['capture', 'old-phone', 'reading_capture']] as const) {
		await env.DB.prepare('INSERT INTO auth_tokens (id, token_hash, device_id, scope) VALUES (?, ?, ?, ?)').bind(id, await sha256Hex(id), deviceId, scope).run();
	}
	await env.DB.prepare("INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, owner_token_id) VALUES ('push', 'https://fcm.googleapis.com/fcm/send/old', 'key', 'secret', 'old-phone')").run();
	const issued = await issue();
	expect((await exchange(issued.code, await device('phone-token'))).status).toBe(200);
	expect(await vaultTokens()).toEqual([{ id: 'desktop', device_id: 'desktop' }, { id: issued.tokenId, device_id: 'phone' }].sort((a, b) => a.id.localeCompare(b.id)));
	expect(await env.DB.prepare("SELECT id FROM auth_tokens WHERE id = 'capture'").first()).toBeNull();
	expect(await env.DB.prepare("SELECT id FROM push_subscriptions WHERE id = 'push'").first()).toBeNull();
});

it('serves the pairing page and redemption through the public Worker routes', async () => {
	const page = await worker.fetch(new Request(`https://test${DEVICE_PAIRING_PAGE}`), env);
	expect(page.status).toBe(200);
	expect(await page.text()).toContain('Open in Obsidian');
	expect((await worker.fetch(new Request(`https://test${DEVICE_PAIRING_PAGE}.js`), env)).status).toBe(200);
	const issued = await issue();
	const response = await worker.fetch(new Request(`https://test${DEVICE_PAIRING_PATH}`, { method: 'POST', headers: {
		'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current),
	}, body: JSON.stringify({ code: issued.code, ...await device('phone-token') }) }), env);
	expect(response.status).toBe(200);
	expect(response.headers.get('Cache-Control')).toBe('no-store');
});
