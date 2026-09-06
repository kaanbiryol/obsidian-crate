/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { listPushSubscriptionIds } from './notifications/push';
import { pruneExpiredTokens } from './maintenance/database';

afterEach(async () => { await reset(); });
async function execute(sql: string) {
	for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
}
async function subscribe(id: string, owner: string | null, folder: string | null) {
	await env.DB.prepare('INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, owner_token_id, folder_path) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(id, `https://fcm.googleapis.com/${id}`, 'key', 'auth', owner, folder).run();
}
it('authorizes live scoped recipients at send selection without waiting for cron', async () => {
	await execute(schema);
	await env.DB.prepare("INSERT INTO notification_policy (id, folder_path, timezone, revision) VALUES (1, 'Private', 'UTC', 'policy')").run();
	for (const [id, folder, expiry] of [['expired', 'Private', Date.now() - 1], ['live', 'Private', Date.now() + 60_000], ['other', 'Other', Date.now() + 60_000]] as const) {
		await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope, folder_path, expires_at) VALUES (?, ?, 'reminders', ?, ?)").bind(id, id, folder, expiry).run();
		await subscribe(id, id, folder);
	}
	await expect(subscribe('unowned', null, null)).rejects.toThrow('NOT NULL');
	await subscribe('forged-folder', 'other', 'Private');
	expect((await listPushSubscriptionIds(env.DB)).sort()).toEqual(['live']);
	await pruneExpiredTokens(env.DB);
	expect((await listPushSubscriptionIds(env.DB)).sort()).toEqual(['live']);
});
