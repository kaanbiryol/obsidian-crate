/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { handleExchangeRemindersEnrollmentToken } from './notification-enrollment-handlers';
import { issueWebEnrollmentToken } from './web-enrollment';
import { sha256Hex } from './auth';

beforeEach(async () => { for (const sql of schema.split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { await reset(); });

it.each(['expired', 'active', 'vault'])('replaces a %s browser credential without widening revocation authority', async kind => {
  const oldToken = 'old-browser-credential';
  await env.DB.prepare('INSERT INTO auth_tokens (id, token_hash, scope, folder_path, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind('old', await sha256Hex(oldToken), kind === 'vault' ? 'vault' : 'reminders', 'OldFolder', kind === 'expired' ? Date.now() - 1000 : Date.now() + 60_000).run();
  await env.DB.prepare('INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, owner_token_id) VALUES (?, ?, ?, ?, ?)')
    .bind('old-push', 'https://fcm.googleapis.com/fcm/send/old', 'key', 'secret', 'old').run();
  const enrollment = await issueWebEnrollmentToken(env.DB, 'NewFolder');
  const request = () => new Request('https://test/exchange', { method: 'POST', body: JSON.stringify({ token: enrollment.token, previousAuthToken: oldToken }) });
  const response = await handleExchangeRemindersEnrollmentToken(request(), env.DB);
  expect(response.status).toBe(200);
  const { authToken } = await response.json() as { authToken: string };
  expect(await env.DB.prepare('SELECT scope, folder_path FROM auth_tokens WHERE token_hash = ?').bind(await sha256Hex(authToken)).first())
    .toMatchObject({ scope: 'reminders', folder_path: 'NewFolder' });
  const old = await env.DB.prepare("SELECT id FROM auth_tokens WHERE id = 'old'").first();
  const push = await env.DB.prepare("SELECT id FROM push_subscriptions WHERE id = 'old-push'").first();
  if (kind === 'vault') { expect(old).not.toBeNull(); expect(push).not.toBeNull(); }
  else { expect(old).toBeNull(); expect(push).toBeNull(); }
  expect((await handleExchangeRemindersEnrollmentToken(request(), env.DB)).status).toBe(401);
});
