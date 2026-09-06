/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { writeCommittedMarkdownFile } from './storage';
import { drainNotificationProjections } from './notification-projection';
import { handleNotificationPolicy } from './notification-policy';
import { ReminderAlarm } from './notifications/reminder-alarm';
import { sendToAllSubscriptions } from './notifications/push';
import { handleDiagnostics } from './maintenance/diagnostics';
vi.mock('./notifications/push', () => ({ listPushSubscriptionIds: vi.fn(async () => ['sub']), sendToAllSubscriptions: vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0, quarantined: 0, errors: [], failedSubscriptionIds: [] })) }));
beforeEach(async () => { for (const sql of schema.split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { vi.clearAllMocks(); await reset(); });
const id = '11111111-1111-4111-8111-111111111111';
interface Command { reminderId: string; content: string; dueDatetime: string; project?: string; jobToken: string }
const note = `- [ ] Old title @2099-01-02T10:00:00.000Z <!-- crate-id:${id} -->`;
function state() {
  const values = new Map<string, unknown>(); let alarmTime: number | null = null;
  return { storage: { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); }, delete: async (key: string) => values.delete(key), deleteAll: async () => values.clear(), getAlarm: async () => alarmTime, setAlarm: async (value: number | Date) => { alarmTime = Number(value); }, deleteAlarm: async () => { alarmTime = null; } } };
}
async function setup() {
  await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: null }) }), env.DB);
  const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note, null);
  await drainNotificationProjections(env);
  const job = await env.DB.prepare('SELECT job_token, payload_json FROM notification_jobs').first<{ job_token: string; payload_json: string }>();
  const alarmState = state();
  const alarm = new ReminderAlarm(alarmState as never, env);
  const body = { ...JSON.parse(job!.payload_json) as Omit<Command, 'jobToken'>, jobToken: job!.job_token };
  expect((await alarm.fetch(new Request('https://do', { method: 'PUT', body: JSON.stringify(body) }))).status).toBe(200);
  return { first, alarm, body, alarmState };
}
it.each(['complete', 'change title'])('fences old delivery after projection but before its outbox command (%s)', async action => {
  const { first, alarm } = await setup();
  await env.DB.prepare('DELETE FROM notification_jobs').run();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', action === 'complete' ? note.replace('[ ]', '[x]') : note.replace('Old title', 'New title'), first.hash);
  await drainNotificationProjections(env);
  const pending = await env.DB.prepare('SELECT operation FROM notification_jobs').first();
  expect(pending).toMatchObject({ operation: action === 'complete' ? 'cancel' : 'schedule' });
  await alarm.alarm();
  expect(sendToAllSubscriptions).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT * FROM scheduled_reminders').first()).not.toBeNull();
});
it('deduplicates an acknowledged delivery when the same outbox job retries after restart', async () => {
  const { alarm, body, alarmState } = await setup();
  await alarm.alarm();
  expect(sendToAllSubscriptions).toHaveBeenCalledTimes(1);
  const restarted = new ReminderAlarm(alarmState as never, env);
  expect((await restarted.fetch(new Request('https://do', { method: 'PUT', body: JSON.stringify(body) }))).status).toBe(200);
  await restarted.alarm();
  expect(sendToAllSubscriptions).toHaveBeenCalledTimes(1);
});
it('reports exhausted delivery after restart without rearming the same occurrence', async () => {
  const { alarm, alarmState } = await setup();
  await env.DB.prepare('DELETE FROM notification_jobs').run();
  await alarmState.storage.put('retryAttempt', 10);
  vi.mocked(sendToAllSubscriptions).mockResolvedValueOnce({ sent: 0, failed: 1, pruned: 0, quarantined: 0, errors: ['provider unavailable'], failedSubscriptionIds: ['sub'] });
  await alarm.alarm();
  expect(await alarmState.storage.get('deliveryFailure')).toMatchObject({ attempts: 10 });
  expect(await alarmState.storage.getAlarm()).toBeNull();
  const diagnostics: unknown = await (await handleDiagnostics(env.DB)).json();
  expect(diagnostics).toMatchObject({ status: 'ok', counts: { scheduledReminders: 1, pendingNotificationJobs: 0, pendingNotificationProjections: 0, failedNotificationJobs: 0, failedNotificationProjections: 0, failedNotificationDeliveries: 1 } });
});

async function currentCommand() {
  const job = await env.DB.prepare('SELECT job_token, payload_json FROM notification_jobs').first<{ job_token: string; payload_json: string }>();
  return { ...JSON.parse(job!.payload_json) as Omit<Command, 'jobToken'>, jobToken: job!.job_token };
}

it('delivers the updated title only after its current outbox command is applied', async () => {
  const { first, alarm } = await setup();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note.replace('Old title', 'Current title'), first.hash);
  await drainNotificationProjections(env);
  await alarm.alarm();
  expect(sendToAllSubscriptions).not.toHaveBeenCalled();
  expect((await alarm.fetch(new Request('https://do', { method: 'PUT', body: JSON.stringify(await currentCommand()) }))).status).toBe(200);
  await alarm.alarm();
  expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
  expect(sendToAllSubscriptions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: 'Current title' }), expect.anything());
});

it('retains recipient completion when the same occurrence is reprojected during delivery', async () => {
  const { first, alarm } = await setup();
  let started!: () => void;
  const sending = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  vi.mocked(sendToAllSubscriptions).mockImplementationOnce(async () => {
    started();
    await new Promise<void>(resolve => { finish = resolve; });
    return { sent: 1, failed: 0, pruned: 0, quarantined: 0, errors: [], failedSubscriptionIds: [] };
  });
  const delivery = alarm.alarm();
  await sending;
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', note.replace('Old title', 'Current title'), first.hash);
  await drainNotificationProjections(env);
  expect((await alarm.fetch(new Request('https://do', { method: 'PUT', body: JSON.stringify(await currentCommand()) }))).status).toBe(200);
  const nextDelivery = alarm.alarm();
  finish();
  await Promise.all([delivery, nextDelivery]);
  expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
});

it('does not clear a terminal failure when the same schedule is retried', async () => {
  const { alarm, alarmState, body } = await setup();
  await alarmState.storage.put('retryAttempt', 10);
  vi.mocked(sendToAllSubscriptions).mockResolvedValueOnce({ sent: 0, failed: 1, pruned: 0, quarantined: 0, errors: ['offline'], failedSubscriptionIds: ['sub'] });
  await alarm.alarm();
  const restarted = new ReminderAlarm(alarmState as never, env);
  expect((await restarted.fetch(new Request('https://do', { method: 'PUT', body: JSON.stringify(body) }))).status).toBe(200);
  expect(await alarmState.storage.getAlarm()).toBeNull();
  expect(await (await handleDiagnostics(env.DB)).json()).toMatchObject({ counts: { failedNotificationDeliveries: 1 }, oldestNotificationFailureAt: expect.any(String) as string });
});
