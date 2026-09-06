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

it.each([0, 1, 2, 3, 4])('rolls back every exchange side effect when statement boundary %i fails', async boundary => {
  const previous = 'previous-session';
  await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope, folder_path) VALUES ('previous', ?, 'reminders', 'OldFolder')").bind(await sha256Hex(previous)).run();
  await env.DB.prepare("INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, owner_token_id) VALUES ('push', 'https://fcm.googleapis.com/fcm/send/test', 'key', 'auth', 'previous')").run();
  const enrollment = await issueWebEnrollmentToken(env.DB, 'NewFolder');
  const request = () => new Request('https://test/exchange', { method: 'POST', body: JSON.stringify({ token: enrollment.token, previousAuthToken: previous }) });
  const failing = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: (statements: D1PreparedStatement[]) => env.DB.batch([
      ...statements.slice(0, boundary),
      env.DB.prepare("INSERT INTO crate_schema (id, version) VALUES (2, 2)"), // CHECK(id = 1) fails inside the real transaction.
      ...statements.slice(boundary),
    ]),
  } as unknown as D1Database;
  await expect(handleExchangeRemindersEnrollmentToken(request(), failing)).rejects.toThrow();
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM web_enrollment_tokens').first()).toMatchObject({ count: 1 });
  expect(await env.DB.prepare('SELECT id FROM auth_tokens').all()).toMatchObject({ results: [{ id: 'previous' }] });
  expect(await env.DB.prepare('SELECT id FROM push_subscriptions').all()).toMatchObject({ results: [{ id: 'push' }] });
  expect((await handleExchangeRemindersEnrollmentToken(request(), env.DB)).status).toBe(200);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM auth_tokens').first()).toMatchObject({ count: 1 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').first()).toMatchObject({ count: 0 });
});

it('allows only one concurrent exchange of an enrollment token', async () => {
  const enrollment = await issueWebEnrollmentToken(env.DB, 'Reminders');
  const results = await Promise.all(Array.from({ length: 4 }, () => handleExchangeRemindersEnrollmentToken(
    new Request('https://test/exchange', { method: 'POST', body: JSON.stringify({ token: enrollment.token }) }), env.DB)));
  expect(results.map(result => result.status).sort()).toEqual([200, 401, 401, 401]);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM auth_tokens').first()).toMatchObject({ count: 1 });
});

it.each(['expired', 'missing'])('cannot revoke a previous session with a %s enrollment token', async kind => {
  const enrollment = await issueWebEnrollmentToken(env.DB, 'Reminders');
  await env.DB.prepare('UPDATE web_enrollment_tokens SET expires_at = ?').bind(Date.now()).run();
  const previous = 'previous-session';
  await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope) VALUES ('previous', ?, 'reminders')").bind(await sha256Hex(previous)).run();
  const response = await handleExchangeRemindersEnrollmentToken(new Request('https://test/exchange', { method: 'POST', body: JSON.stringify({ token: kind === 'expired' ? enrollment.token : 'missing', previousAuthToken: previous }) }), env.DB);
  expect(response.status).toBe(401);
  expect(await env.DB.prepare('SELECT id FROM auth_tokens').all()).toMatchObject({ results: [{ id: 'previous' }] });
});

it('keeps a committed exchange single-use if its response is lost', async () => {
  const enrollment = await issueWebEnrollmentToken(env.DB, 'Reminders');
  const request = () => new Request('https://test/exchange', { method: 'POST', body: JSON.stringify({ token: enrollment.token }) });
  const uncertain = { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => {
    await env.DB.batch(statements);
    throw new Error('Response lost after commit');
  } } as unknown as D1Database;
  await expect(handleExchangeRemindersEnrollmentToken(request(), uncertain)).rejects.toThrow('Response lost');
  expect((await handleExchangeRemindersEnrollmentToken(request(), env.DB)).status).toBe(401);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM auth_tokens').first()).toMatchObject({ count: 1 });
});

it('issues hashed ten-minute tokens and purges expired enrollments', async () => {
  await env.DB.prepare("INSERT INTO web_enrollment_tokens (token_hash, expires_at, folder_path) VALUES ('expired', 0, 'Reminders')").run();
  const before = Date.now();
  const enrollment = await issueWebEnrollmentToken(env.DB, 'Reminders');
  expect(enrollment.token).toHaveLength(64);
  expect(enrollment.expiresAt).toBeGreaterThanOrEqual(before + 600_000);
  expect(enrollment.expiresAt).toBeLessThanOrEqual(Date.now() + 600_000);
  expect(await env.DB.prepare('SELECT token_hash FROM web_enrollment_tokens').all()).toMatchObject({ results: [{ token_hash: await sha256Hex(enrollment.token) }] });
});
