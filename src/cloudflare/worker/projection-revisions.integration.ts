/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { writeCommittedMarkdownFile } from './storage';
import { handleDelete } from './sync-file-handlers';
import { drainNotificationProjections, notificationDatetime } from './notification-projection';
import { handleNotificationPolicy } from './notification-policy';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { drainNotificationJobs } from './notification-outbox';
import { runNotificationCoordinator } from './notification-coordinator';
import { getStoredFileRow } from './sync-storage';

beforeEach(async () => { for (const sql of schema.split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const policy = { folderPath: 'Reminders', timezone: 'America/New_York', allDayTime: '09:00', revision: 'policy1' };
async function configure() {
  await handleNotificationPolicy(new Request('https://test/reminders/notification-policy', { method: 'POST', body: JSON.stringify(policy) }), env.DB);
}
const note = '- [ ] Due @2099-01-02T10:00:00.000Z <!-- crate-id:11111111-1111-4111-8111-111111111111 -->';
async function jobs() { expect((await env.DB.prepare('SELECT last_error FROM notification_projection_jobs WHERE last_error IS NOT NULL').all()).results).toEqual([]); return (await env.DB.prepare('SELECT reminder_id, operation, payload_json FROM notification_jobs').all()).results; }

describe('authoritative projections and file revisions', () => {
  it('keeps a recreated same-content file when an earlier delete is retried', async () => {
    const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'note.md', 'same', null);
    const prior = await getStoredFileRow(env.DB, 'note.md');
    const request = () => new Request('https://test/sync/delete', { method: 'POST', body: JSON.stringify({ path: 'note.md', expectedHash: first.hash, expectedRevision: prior?.storageKey }) });
    expect((await handleDelete(request(), env.BUCKET, env.DB)).status).toBe(200);
    await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'note.md', 'same', null);
    expect((await handleDelete(request(), env.BUCKET, env.DB)).status).toBe(409);
    expect(await getStoredFileRow(env.DB, 'note.md')).not.toBeNull();
  });
  it('records projection intent even when a file commit response is lost', async () => {
    await configure();
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => { await batch(statements); throw new Error('lost'); });
    await expect(writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note, null)).rejects.toThrow('lost');
    await drainNotificationProjections(env);
    expect(await jobs()).toMatchObject([{ reminder_id: '11111111-1111-4111-8111-111111111111', operation: 'schedule' }]);
  });
  it('projects the latest committed reminder after multiple updates and a deletion', async () => {
    await configure();
    const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note, null);
    await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note.replace('Due', 'New title'), first.hash);
    await drainNotificationProjections(env);
    expect(JSON.parse(String((await jobs())[0]?.payload_json))).toMatchObject({ content: 'New title' });
    const file = await getStoredFileRow(env.DB, 'Reminders/Inbox.md');
    await handleDelete(new Request('https://test/sync/delete', { method: 'POST', body: JSON.stringify({ path: 'Reminders/Inbox.md', expectedHash: file?.hash, expectedRevision: file?.storageKey }) }), env.BUCKET, env.DB);
    await drainNotificationProjections(env);
    expect(await jobs()).toMatchObject([{ reminder_id: '11111111-1111-4111-8111-111111111111', operation: 'cancel' }]);
  });
  it('does not allow startup on another device to replace the saved timezone policy', async () => {
    await configure();
    const response = await handleNotificationPolicy(new Request('https://test/reminders/notification-policy', { method: 'POST', body: JSON.stringify({ ...policy, timezone: 'Asia/Tokyo', allDayTime: null }) }), env.DB);
    expect(await response.json()).toMatchObject({ policy: { timezone: 'America/New_York', allDayTime: '09:00' } });
    expect(notificationDatetime({ dueDate: '2027-03-14' }, policy)).toBe('2027-03-14T13:00:00.000Z');
  });
});

it('defers delivery while its committed source revision awaits projection', async () => {
  await configure();
  const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note, null);
  await drainNotificationProjections(env); await drainNotificationJobs(env);
  const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('11111111-1111-4111-8111-111111111111'));
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note.replace('Due', 'Latest'), first.hash);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await env.DB.prepare('SELECT content FROM scheduled_reminders').first()).toMatchObject({ content: 'Due' });
  const state = await (await stub.fetch('https://do/status')).json() as { alarmTime: number };
  expect(state.alarmTime).toBeGreaterThan(Date.now());
  await drainNotificationProjections(env); await drainNotificationJobs(env);
  expect(await env.DB.prepare('SELECT content FROM scheduled_reminders').first()).toMatchObject({ content: 'Latest' });
});
it('ignores an outbox command superseded by a newer projection job', async () => {
  await configure();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note, null);
  await drainNotificationProjections(env);
  const job = await env.DB.prepare('SELECT reminder_id, job_token, payload_json FROM notification_jobs').first<{ reminder_id: string; job_token: string; payload_json: string }>();
  await env.DB.prepare("UPDATE notification_jobs SET job_token = 'newer', operation = 'cancel', payload_json = NULL").run();
  const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName(job!.reminder_id));
  const response = await stub.fetch('https://do/schedule', { method: 'PUT', body: JSON.stringify({ ...JSON.parse(job!.payload_json), jobToken: job!.job_token }) });
  expect(await response.json()).toMatchObject({ superseded: true });
  expect(await env.DB.prepare('SELECT * FROM scheduled_reminders').first()).toBeNull();
});
it('does not continuously wake a coordinator before a notification policy is configured', async () => {
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note, null);
  const setAlarm = vi.fn();
  await runNotificationCoordinator({ storage: { setAlarm } } as never, env);
  expect(setAlarm).not.toHaveBeenCalled();
});
it('disables all derived schedules through an explicit policy revision', async () => {
  await configure();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note, null);
  await drainNotificationProjections(env); await drainNotificationJobs(env);
  const current = await env.DB.prepare('SELECT revision FROM notification_policy').first<{ revision: string }>();
  expect((await handleNotificationPolicy(new Request('https://test/policy', { method: 'PUT', body: JSON.stringify({ ...policy, enabled: false, expectedRevision: current!.revision }) }), env.DB)).status).toBe(200);
  await drainNotificationProjections(env); await drainNotificationJobs(env);
  expect(await env.DB.prepare('SELECT * FROM scheduled_reminders').first()).toBeNull();
});
