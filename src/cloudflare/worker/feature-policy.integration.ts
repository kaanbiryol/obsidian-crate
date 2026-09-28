/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { featurePolicy, handleFeaturePolicy } from './feature-policy';
import { handleReadingRoute } from './reading/routes';
import { createReadingNote } from '@/reading/core/notes';
import type { PendingCapture } from './reading/captures';
import { projectReading } from './reading/projection';
import { policy } from './reading/common';
import { publishExtraction, type Publication } from './reading/extraction/jobs';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from './storage';
import { handleNotificationPolicy } from './notification-policy';
import { drainNotificationProjections } from './notification-projection';
import { ReminderAlarm } from './notifications/reminder-alarm';
import { sendToAllSubscriptions } from './notifications/push';
import { isAuthenticatedRouteAllowed } from './router';
vi.mock('./notifications/push', () => ({ listPushSubscriptionIds: vi.fn(async () => ['sub']), sendToAllSubscriptions: vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0, quarantined: 0, errors: [], failedSubscriptionIds: [] })) }));
beforeEach(async () => {
  await env.DB.batch(schema.split(';').map(s => s.trim()).filter(Boolean).map(s => env.DB.prepare(s)));
  await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
});
afterEach(async () => { vi.clearAllMocks(); await reset(); });
const req = (path: string, body: unknown) => new Request(`https://test/${path}`, { method: 'POST', body: JSON.stringify(body) });
const reading = (path: string, body: Record<string, unknown>) => handleReadingRoute(req(`reading/${path}`, body), env, { tokenId: 'vault', scope: 'vault' });
async function toggle(feature: 'reading' | 'reminders', enabled: boolean) {
  const current = await featurePolicy(env.DB);
  const response = await handleFeaturePolicy(req('features', { feature, enabled, revision: current.revision }), env.DB);
  expect(response.status, await response.clone().text()).toBe(200);
}
it('defaults on, rejects stale edits, and limits writes to vault credentials', async () => {
  expect(await featurePolicy(env.DB)).toEqual({ reading: true, reminders: true, revision: null });
  await toggle('reading', false);
  expect((await handleFeaturePolicy(req('features', { feature: 'reminders', enabled: false, revision: null }), env.DB)).status).toBe(409);
  expect(await featurePolicy(env.DB)).toMatchObject({ reading: false, reminders: true });
  expect(isAuthenticatedRouteAllowed({ tokenId: 'browser', scope: 'reminders' }, '/features', 'GET')).toBe(true);
  expect(isAuthenticatedRouteAllowed({ tokenId: 'browser', scope: 'reminders' }, '/features', 'POST')).toBe(false);
  expect(isAuthenticatedRouteAllowed({ tokenId: 'shortcut', scope: 'reading_capture' }, '/features', 'GET')).toBe(false);
});
it('blocks capture and publication while paused and resumes the retained article job', async () => {
  await reading('policy', { enabled: true, folderPath: 'Reading', revision: null });
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Article.md', createReadingNote({ id: crypto.randomUUID(), url: 'https://example.invalid/article', savedAt: new Date().toISOString() }), null);
  await projectReading(env, (await policy(env.DB))!);
  const job = (await env.DB.prepare('SELECT * FROM reading_jobs').first<Publication['job']>())!;
  const original = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path);
  await toggle('reading', false);
  expect((await reading('capture', { url: 'https://example.invalid/new', fetchArticle: true, operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)) })).status).toBe(423);
  const publication = { job, result: { markdown: 'Saved article text', title: 'Article', author: '', faviconUrl: '' } };
  await publishExtraction(env, publication);
  expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))?.content).toBe(original?.content);
  expect(await env.DB.prepare('SELECT 1 FROM reading_jobs').first()).not.toBeNull();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Ordinary.md', 'Sync still works.', null);
  await toggle('reading', true);
  await publishExtraction(env, publication);
  expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))?.content).toContain('Saved article text');
});
it('retains notification state while paused, rearms on resume, and never repeats a completed delivery', async () => {
  await handleNotificationPolicy(req('policy', { folderPath: 'Reminders', timezone: 'UTC', allDayTime: null, enabled: true }), env.DB);
  const id = '11111111-1111-4111-8111-111111111111';
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', `- [ ] Task @2099-01-02T10:00:00.000Z <!-- crate-id:${id} -->`, null);
  await drainNotificationProjections(env);
  const values = new Map<string, unknown>(); let alarmTime: number | null = null;
  const state = { storage: { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); }, delete: async (key: string) => values.delete(key), deleteAll: async () => values.clear(), getAlarm: async () => alarmTime, setAlarm: async (value: number | Date) => { alarmTime = Number(value); }, deleteAlarm: async () => { alarmTime = null; } } };
  const alarm = new ReminderAlarm(state as never, env);
  const schedule = async () => {
    const job = (await env.DB.prepare('SELECT job_token,payload_json FROM notification_jobs').first<{ job_token: string; payload_json: string }>())!;
    const body = { ...JSON.parse(job.payload_json) as Record<string, unknown>, jobToken: job.job_token };
    const response = await alarm.fetch(new Request('https://do/schedule', { method: 'PUT', body: JSON.stringify(body) }));
    expect(response.status, await response.clone().text()).toBe(200);
    await env.DB.prepare('DELETE FROM notification_jobs').run();
  };
  await schedule();
  await toggle('reminders', false);
  await alarm.alarm();
  expect(sendToAllSubscriptions).not.toHaveBeenCalled();
  expect(alarmTime).toBeNull();
  expect(await env.DB.prepare('SELECT 1 FROM scheduled_reminders').first()).not.toBeNull();
  expect(await env.DB.prepare('SELECT enabled FROM notification_policy').first()).toEqual({ enabled: 1 });
  await toggle('reminders', true);
  await schedule();
  expect(alarmTime).not.toBeNull();
  await alarm.alarm();
  expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
  await toggle('reminders', false); await toggle('reminders', true);
  await alarm.alarm();
  expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
});


it('retains queued captures while paused and publishes them after resume', async () => {
  await reading('policy', { enabled: true, folderPath: 'Reading', revision: null });
  expect((await reading('capture', { url: 'https://example.invalid/queued', operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)) })).status).toBe(200);
  const capture = (await env.DB.prepare('SELECT * FROM reading_captures').first<PendingCapture>())!;
  await toggle('reading', false);
  await publishExtraction(env, { captureId: capture.id, generation: capture.generation, result: { markdown: 'Saved article text', title: 'Article' } });
  expect(await env.DB.prepare('SELECT * FROM reading_captures').first()).toEqual(capture);
  expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
  await toggle('reading', true);
  await publishExtraction(env, { captureId: capture.id, generation: capture.generation, result: { markdown: 'Saved article text', title: 'Article' } });
  expect(await env.DB.prepare('SELECT 1 FROM reading_captures').first()).toBeNull();
  const file = (await env.DB.prepare('SELECT path FROM files').first<{ path: string }>())!;
  expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, file.path))?.content).toContain('Saved article text');
});
