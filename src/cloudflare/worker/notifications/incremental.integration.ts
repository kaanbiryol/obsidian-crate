/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { handleNotificationPolicy } from './policy';
import { writeCommittedMarkdownFile } from '../storage';
import { drainNotificationProjections } from './projection';
import { drainNotificationJobs } from './outbox';
import { hasNotificationAuthority } from '../reminders/source-state';
import { runNotificationCoordinator } from './coordinator';

const path = 'Reminders/Inbox.md';
const due = '2099-01-01T12:00:00.000Z';
const note = (id: string, title = 'Task', date = due) => `- [ ] ${title}${date ? ` ${date}` : ''} <!-- crate-id:${id} -->`;
beforeEach(async () => {
  await applySchema(env.DB);
  await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({
    folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00',
  }) }), env.DB);
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const jobs = async () => (await env.DB.prepare('SELECT reminder_id, job_token, operation, attempts, available_at FROM notification_jobs ORDER BY reminder_id').all()).results;

it('edits one installed schedule without requeuing its eleven unchanged neighbors', async () => {
  const ids = Array.from({ length: 12 }, () => crypto.randomUUID());
  const content = ids.map(id => note(id)).join('\n');
  const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
  await drainNotificationProjections(env);
  await drainNotificationJobs(env); await drainNotificationJobs(env);
  const original = (await env.DB.prepare('SELECT reminder_id, schedule_token FROM scheduled_reminders ORDER BY reminder_id').all<{ reminder_id: string; schedule_token: string }>()).results;
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content.replace(note(ids[0]!), note(ids[0]!, 'Changed')), first.hash);
  await drainNotificationProjections(env);
  expect(await jobs()).toMatchObject([{ reminder_id: ids[0], operation: 'schedule' }]);
  for (const row of original.filter(row => row.reminder_id !== ids[0])) {
    expect(await hasNotificationAuthority(env.DB, row.reminder_id, row.schedule_token)).toBe(true);
  }
  await drainNotificationJobs(env);
  const after = (await env.DB.prepare('SELECT reminder_id, schedule_token FROM scheduled_reminders ORDER BY reminder_id').all()).results;
  expect(after.filter(row => row.reminder_id !== ids[0])).toEqual(original.filter(row => row.reminder_id !== ids[0]));
  expect(await env.DB.prepare('SELECT content FROM scheduled_reminders WHERE reminder_id = ?').bind(ids[0]).first()).toEqual({ content: 'Changed' });
});

it('preserves matching pending jobs and their retry deadlines when another reminder changes', async () => {
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
  const content = ids.map(id => note(id)).join('\n');
  const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
  await drainNotificationProjections(env);
  await env.DB.prepare('UPDATE notification_jobs SET attempts = 3, available_at = ?, last_error = ?').bind(Date.now() + 60_000, 'temporary').run();
  const before = await jobs();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content.replace(note(ids[0]!), note(ids[0]!).replace('[ ]', '[x]')), first.hash);
  await drainNotificationProjections(env);
  const after = await jobs();
  expect(after.filter(row => row.reminder_id !== ids[0])).toEqual(before.filter(row => row.reminder_id !== ids[0]));
  expect(after.find(row => row.reminder_id === ids[0])).toMatchObject({ operation: 'cancel', attempts: 0, available_at: 0 });
});

it('queues just one alarm when adding a date among 400 previously projected undated reminders', async () => {
  const ids = Array.from({ length: 400 }, () => crypto.randomUUID());
  const content = ids.map(id => note(id, 'Task', '')).join('\n');
  const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
  await drainNotificationProjections(env);
  expect(await jobs()).toEqual([]);
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content.replace(note(ids[0]!, 'Task', ''), note(ids[0]!)), first.hash);
  await drainNotificationProjections(env);
  expect(await jobs()).toMatchObject([{ reminder_id: ids[0], operation: 'schedule' }]);
});

it('repairs missing schedule state instead of treating a projection record as proof of installation', async () => {
  const content = note(crypto.randomUUID());
  const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
  await drainNotificationProjections(env);
  await env.DB.prepare('DELETE FROM notification_jobs').run();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content + '\nUnrelated note', first.hash);
  await drainNotificationProjections(env);
  expect(await jobs()).toHaveLength(1);
  await drainNotificationJobs(env);
  expect(await env.DB.prepare('SELECT content FROM scheduled_reminders').first()).toEqual({ content: 'Task' });
});

it('continues ready batches immediately and keeps future retry deadlines', async () => {
  const content = Array.from({ length: 11 }, () => note(crypto.randomUUID())).join('\n');
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
  const setAlarm = vi.fn();
  const state = { storage: { setAlarm } } as never;
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await runNotificationCoordinator(state, env);
  expect(await jobs()).toHaveLength(1);
  expect(setAlarm).toHaveBeenLastCalledWith(now + 1);
  const retryAt = now + 60_000;
  await env.DB.prepare('UPDATE notification_jobs SET available_at = ?').bind(retryAt).run();
  setAlarm.mockClear();
  await runNotificationCoordinator(state, env);
  expect(setAlarm).toHaveBeenCalledExactlyOnceWith(retryAt);
  vi.mocked(Date.now).mockReturnValue(retryAt);
  setAlarm.mockClear();
  await runNotificationCoordinator(state, env);
  expect(await jobs()).toEqual([]);
  expect(setAlarm).not.toHaveBeenCalled();
});

it('does not requeue delivered occurrences outside the delivery window on unrelated edits', async () => {
  const id = crypto.randomUUID();
  const content = note(id);
  const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
  await drainNotificationProjections(env);
  await drainNotificationJobs(env);
  // Delivery removes the installed schedule.
  await env.DB.prepare('DELETE FROM scheduled_reminders').run();
  const dueAt = Date.parse(due);
  vi.spyOn(Date, 'now').mockReturnValue(dueAt + 60 * 60 * 1000);
  const second = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, `${content}\nUnrelated note`, first.hash);
  await drainNotificationProjections(env);
  expect(await jobs()).toMatchObject([{ reminder_id: id, operation: 'schedule' }]);
  await env.DB.prepare('DELETE FROM notification_jobs').run();
  vi.mocked(Date.now).mockReturnValue(dueAt + 25 * 60 * 60 * 1000);
  const third = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, `${content}\nAnother note`, second.hash);
  await drainNotificationProjections(env);
  expect(await jobs()).toEqual([]);
  const snoozed = '2099-01-03T12:00:00.000Z';
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, note(id, 'Task', snoozed), third.hash);
  await drainNotificationProjections(env);
  expect(await jobs()).toMatchObject([{ reminder_id: id, operation: 'schedule' }]);
});
