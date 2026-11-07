/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { revokeCoordinatedCredential } from '../coordinator/coordinator';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { await reset(); });

it('revokes a credential with what it owns through the coordinator', async () => {
	await env.DB.batch([
		env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope) VALUES ('issuer', ?, 'vault'), ('other', ?, 'vault')").bind('a'.repeat(64), 'b'.repeat(64)),
		env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, device_id, scope) VALUES ('capture', ?, 'issuer', 'reading_capture')").bind('c'.repeat(64)),
		env.DB.prepare("INSERT INTO push_subscriptions (id, owner_token_id, endpoint, p256dh, auth) VALUES ('push', 'issuer', 'https://push.example', 'key', 'auth')"),
	]);
	expect(await revokeCoordinatedCredential(env, 'issuer')).toBe(true);
	expect((await env.DB.prepare('SELECT id FROM auth_tokens').all()).results).toEqual([{ id: 'other' }]);
	expect(await env.DB.prepare('SELECT 1 FROM push_subscriptions').first()).toBeNull();
	expect(await revokeCoordinatedCredential(env, 'issuer')).toBe(false);
});
