import { CRATE_PLUGIN_PROTOCOL } from '@/protocol';
/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex } from './auth';
import { handleSubscribe, handleUnsubscribe } from './notification-subscription-handlers';
import { isValidPushEndpoint } from './notifications/push-endpoint';
import { writeCommittedMarkdownFile } from './storage';
import { makeApiFetch } from '@/pwa/api';
import { performPwaLogout } from '@/pwa/hooks/usePwaSessionLifecycle';
import { invalidatePwaSession } from '@/pwa/session-generation';

beforeEach(async () => { for (const sql of schema.split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
async function token(id: string, scope = 'reminders', folder: string | null = 'Reminders') {
  await env.DB.prepare('INSERT INTO auth_tokens (id, token_hash, scope, expires_at, folder_path) VALUES (?, ?, ?, ?, ?)')
    .bind(id, await sha256Hex(id), scope, Date.now() + 60_000, folder).run();
}
const request = (path: string, id: string, body?: unknown, method = 'POST', protocol = String(CRATE_PLUGIN_PROTOCOL.current)) => new Request(`https://test${path}`, {
  method, headers: { Authorization: `Bearer ${id}`, 'X-Crate-Protocol': protocol, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const subscription = (suffix: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh: 'key', auth: 'auth' } });

it.each(['', '2', '3', '4', '5', String(CRATE_PLUGIN_PROTOCOL.current + 1)])('rejects protocol %s before committing a mutation', async protocol => {
  await token('vault-token', 'vault', null);
  expect((await worker.fetch(request('/sync/upload?path=a.md', 'vault-token', {}, 'PUT', protocol), env)).status).toBe(428);
  expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM files').first<{ count: number }>())?.count).toBe(0);
});
it('binds reads, source edits, and enrollment permissions to the original folder', async () => {
  await token('browser');
  expect((await worker.fetch(request('/reminders/list?folderPath=Private', 'browser', undefined, 'GET'), env)).status).toBe(403);
  expect((await worker.fetch(request('/reminders/create', 'browser', { folderPath: 'Private', content: 'No', project: 'Inbox', operationId: crypto.randomUUID() }), env)).status).toBe(403);
  expect((await worker.fetch(request('/notifications/reminders-enrollment-token', 'browser', { folderPath: 'Private' }), env)).status).toBe(403);
  expect((await worker.fetch(request('/reminders/list?folderPath=Reminders', 'browser', undefined, 'GET'), env)).status).toBe(200);
  await token('unbound', 'reminders', null);
  expect((await worker.fetch(request('/reminders/list?folderPath=Reminders', 'unbound', undefined, 'GET'), env)).status).toBe(401);
});
it('cannot replace or unsubscribe another session’s endpoint and revokes owned push on logout', async () => {
  await token('one'); await token('two');
  const body = subscription('shared');
  expect((await handleSubscribe(request('/notifications/subscribe', 'one', body), env.DB, 'one')).status).toBe(200);
  expect((await handleSubscribe(request('/notifications/subscribe', 'two', body), env.DB, 'two')).status).toBe(429);
  await handleUnsubscribe(request('/notifications/subscribe', 'two', { endpoint: body.endpoint }, 'DELETE'), env.DB, 'two');
  expect((await env.DB.prepare('SELECT owner_token_id, folder_path FROM push_subscriptions').first())).toMatchObject({ owner_token_id: 'one', folder_path: 'Reminders' });
  expect((await worker.fetch(request('/auth/session', 'one', undefined, 'DELETE'), env)).status).toBe(200);
  expect(await env.DB.prepare('SELECT id FROM push_subscriptions').first()).toBeNull();
  expect((await worker.fetch(request('/reminders/list?folderPath=Reminders', 'one', undefined, 'GET'), env)).status).toBe(401);
});
it('enforces the per-owner cap during concurrent subscriptions', async () => {
  await token('browser');
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => handleSubscribe(request('/notifications/subscribe', 'browser', subscription(String(i))), env.DB, 'browser')));
  expect(results.filter(response => response.status === 200)).toHaveLength(5);
  expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').first<{ count: number }>())?.count).toBe(5);
});
it('composes browser logout with the real API wrapper and Worker revocation', async () => {
  await token('browser-logout');
  await handleSubscribe(request('/notifications/subscribe', 'browser-logout', subscription('logout')), env.DB, 'browser-logout');
  let localToken: string | null = 'browser-logout';
  vi.stubGlobal('localStorage', { getItem: () => localToken });
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh) Version/26.0 Safari/604.1', maxTouchPoints: 0 });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  const network = vi.fn(async (path: string, init?: RequestInit) => worker.fetch(new Request(`https://test${path}`, init), env));
  vi.stubGlobal('fetch', network);
  expect(await performPwaLogout({
    apiFetch: makeApiFetch(localToken, () => { throw new Error('Unexpected unauthorized callback'); }),
    disablePushNotifications: async () => {},
    clearLocalSession: () => { invalidatePwaSession(); localToken = null; },
  })).toBe(false);
  expect(network.mock.calls.filter(([path]) => path === '/auth/session')).toHaveLength(1);
  expect(await env.DB.prepare("SELECT id FROM push_subscriptions WHERE owner_token_id = 'browser-logout'").first()).toBeNull();
  expect((await worker.fetch(request('/reminders/list?folderPath=Reminders', 'browser-logout', undefined, 'GET'), env)).status).toBe(401);
});
it('rejects internal, arbitrary and malformed push destinations', () => {
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://api.cloudflare.com/x', 'https://fcm.googleapis.com.evil.test/x', 'https://user@fcm.googleapis.com/x', 'https://fcm.googleapis.com:444/x']) expect(isValidPushEndpoint(endpoint)).toBe(false);
  for (const endpoint of ['https://fcm.googleapis.com/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x']) expect(isValidPushEndpoint(endpoint)).toBe(true);
});
it('limits notification test requests without revealing provider responses', async () => {
  await token('vault-token', 'vault', null);
  const responses = await Promise.all(Array.from({ length: 5 }, () => worker.fetch(request('/notifications/test', 'vault-token'), env)));
  expect(responses.filter(response => response.status === 429)).toHaveLength(2);
});
it('keeps healthy reminders available alongside oversized notes without downloading them', async () => {
  await token('browser');
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', '- [ ] Healthy <!-- crate-id:healthy -->', null);
  await env.DB.prepare('INSERT INTO files (path, portable_path, hash, size, storage_key) VALUES (?, ?, ?, ?, ?)')
    .bind('Reminders/Large.md', 'reminders/large.md', 'a'.repeat(64), 2 * 1024 * 1024, 'absent-large-object').run();
  const response = await worker.fetch(request('/reminders/list?folderPath=Reminders', 'browser', undefined, 'GET'), env);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ reminders: [{ content: 'Healthy' }], issues: [{ path: 'Reminders/Large.md' }] });
});
it('cannot bypass public request limits by varying an unverified bearer header', async () => {
  const responses = [];
  for (let i = 0; i < 61; i++) responses.push(await worker.fetch(request('/notifications/reminders-exchange', `unverified-${i}`, { token: 'invalid' }), env));
  expect(responses.at(-1)?.status).toBe(429);
  expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM request_rate_limits').first<{ count: number }>())?.count).toBe(0); // Invalid grants never charge authenticated action/day budgets.
});
