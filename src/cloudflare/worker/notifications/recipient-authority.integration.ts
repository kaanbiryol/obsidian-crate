/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { listPushSubscriptions } from './push';
import { pruneExpiredTokens } from '../maintenance/database';
import { handleSubscribe } from './subscription-handlers';

afterEach(async () => { await reset(); });
async function subscribe(id: string, owner: string | null, folder: string | null) {
	await env.DB.prepare('INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, owner_token_id, folder_path) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(id, `https://fcm.googleapis.com/${id}`, 'key', 'auth', owner, folder).run();
}
it('authorizes live scoped recipients at send selection without waiting for cron', async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO notification_policy (id, folder_path, timezone, revision) VALUES (1, 'Private', 'UTC', 'policy')").run();
	for (const [id, folder, expiry] of [['expired', 'Private', Date.now() - 1], ['live', 'Private', Date.now() + 60_000], ['other', 'Other', Date.now() + 60_000]] as const) {
		await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope, folder_path, expires_at) VALUES (?, ?, 'reminders', ?, ?)").bind(id, id, folder, expiry).run();
		await subscribe(id, id, folder);
	}
	await expect(subscribe('unowned', null, null)).rejects.toThrow('NOT NULL');
	await subscribe('forged-folder', 'other', 'Private');
	expect((await listPushSubscriptions(env.DB)).map(row => row.id).sort()).toEqual(['live']);
	await pruneExpiredTokens(env.DB);
	expect((await listPushSubscriptions(env.DB)).map(row => row.id).sort()).toEqual(['live']);
});

it('saves a push subscription only while its owner token exists and prunes ownerless rows', async () => {
	await applySchema(env.DB);
	const token = (id: string, expiresAt: number) => env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope, folder_path, expires_at) VALUES (?, ?, 'reminders', 'Reminders', ?)")
		.bind(id, id, expiresAt).run();
	const request = (endpoint: string) => new Request('https://test/notifications/subscribe', { method: 'POST', body: JSON.stringify({ endpoint, keys: { p256dh: 'key', auth: 'auth' } }) });
	await token('live', Date.now() + 60_000);
	await token('expired', Date.now() - 1);
	// Each request authenticated first; an edge enrollment exchange revoked one owner before its insert.
	expect((await handleSubscribe(request('https://fcm.googleapis.com/revoked'), env.DB, 'revoked')).status).toBe(429);
	expect((await handleSubscribe(request('https://fcm.googleapis.com/expired'), env.DB, 'expired')).status).toBe(429);
	expect((await handleSubscribe(request('https://fcm.googleapis.com/live'), env.DB, 'live')).status).toBe(200);
	expect((await env.DB.prepare('SELECT owner_token_id FROM push_subscriptions').all()).results).toEqual([{ owner_token_id: 'live' }]);
	// A row left by that race before this guard existed stops counting toward the limits after cleanup.
	await subscribe('ownerless', 'revoked', 'Reminders');
	await pruneExpiredTokens(env.DB);
	expect((await env.DB.prepare('SELECT owner_token_id FROM push_subscriptions').all()).results).toEqual([{ owner_token_id: 'live' }]);
});
