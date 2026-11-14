/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { runScheduledMaintenance } from '../maintenance/run';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { await reset(); });

it('prunes only the folder labels that nothing names', async () => {
	const later = Date.now() + 60_000;
	await env.DB.batch([
		env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'reminders', 'UTC', 'r')"),
		env.DB.prepare("INSERT INTO reading_policy(id, enabled, folder_path, generation, revision) VALUES (1, 1, 'reading', 'g', 'r')"),
		env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope, folder_path) VALUES ('session', 'hash', 'reminders', 'session')"),
		env.DB.prepare("INSERT INTO auth_tokens(id, token_hash) VALUES ('vault', 'vault-hash')"),
		env.DB.prepare("INSERT INTO push_subscriptions(owner_token_id, folder_path, id, endpoint, p256dh, auth) VALUES ('session', 'subscribed', 's', 'https://push.test', 'k', 'a')"),
		env.DB.prepare(`INSERT INTO grants(kind, key, payload, expires_at) VALUES ('web_enrollment', 'link', '{"folderPath":"enrolling"}', ?)`).bind(later),
		...['reminders', 'reading', 'session', 'subscribed', 'enrolling', 'old'].map(folder =>
			env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)').bind(`e2ee:folder:${folder}`, `label:${folder}`)),
		env.DB.prepare("INSERT INTO maintenance_state(key, value) VALUES ('e2ee:folderless', 'kept')"),
	]);
	await runScheduledMaintenance(env);
	const keys = (await env.DB.prepare("SELECT key FROM maintenance_state WHERE key LIKE 'e2ee:%' ORDER BY key").all<{ key: string }>()).results.map(row => row.key);
	expect(keys).toEqual(['e2ee:folder:enrolling', 'e2ee:folder:reading', 'e2ee:folder:reminders', 'e2ee:folder:session', 'e2ee:folder:subscribed', 'e2ee:folderless']);
});
