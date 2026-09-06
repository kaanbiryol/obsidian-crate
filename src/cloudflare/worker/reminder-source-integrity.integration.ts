/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { writeCommittedMarkdownFile } from './storage';
import { writeCommittedMarkdownFilePair } from './atomic-markdown-write';
import { drainNotificationProjections } from './notification-projection';
import { handleNotificationPolicy } from './notification-policy';
import { handleListReminders } from './reminders-web/routes/list';
import { handleDelete } from './sync-file-handlers';
import { getStoredFileRow } from './sync-storage';
import { loadReminderSource } from './reminders-web/workspace';
import { ReminderAlarm } from './notifications/reminder-alarm';
import { sendToAllSubscriptions } from './notifications/push';
import { handleDiagnostics } from './maintenance/diagnostics';

vi.mock('./notifications/push', () => ({
  listPushSubscriptionIds: vi.fn(async () => ['sub']),
  sendToAllSubscriptions: vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0, quarantined: 0, errors: [], failedSubscriptionIds: [] })),
}));
beforeEach(async () => {
  for (const sql of schema.split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00' }) }), env.DB);
});
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await reset(); });
const id = '11111111-1111-4111-8111-111111111111';
const note = (title: string, due: string, done = false) => `- [${done ? 'x' : ' '}] ${title} @${due} <!-- crate-id:${id} -->`;
const list = async (): Promise<unknown> => (await handleListReminders(new Request('https://test/reminders/list?folderPath=Reminders'), env)).json() as Promise<unknown>;
async function remove(path: string) {
  const file = await getStoredFileRow(env.DB, path);
  expect((await handleDelete(new Request('https://test/delete', { method: 'POST', body: JSON.stringify({ path, expectedHash: file?.hash, expectedRevision: file?.storageKey }) }), env.BUCKET, env.DB)).status).toBe(200);
}
async function command() {
  return env.DB.prepare('SELECT operation, job_token, payload_json FROM notification_jobs WHERE reminder_id = ?').bind(id).first<{ operation: string; job_token: string; payload_json: string }>();
}
async function alarmFromCommand() {
  const job = await command();
  const values = new Map<string, unknown>();
  let alarmTime: number | null = null;
  const state = { storage: { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); }, delete: async (key: string) => values.delete(key), getAlarm: async () => alarmTime, setAlarm: async (value: number | Date) => { alarmTime = Number(value); }, deleteAlarm: async () => { alarmTime = null; } } };
  const alarm = new ReminderAlarm(state as never, env);
  expect((await alarm.fetch(new Request('https://do/schedule', { method: 'PUT', body: JSON.stringify({ ...JSON.parse(job!.payload_json), jobToken: job!.job_token }) }))).status).toBe(200);
  return { alarm, state };
}

it.each(['unchanged', 'title edit', 'project move', 'rename'])('delivers a first projection delayed across its deadline (%s)', async action => {
  const now = Date.now();
  const due = new Date(now + 60_000).toISOString();
  const content = note('Due', due);
  const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', content, null);
  vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
  if (action === 'title edit') await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', note('Edited', due), first.hash);
  if (action === 'project move') await writeCommittedMarkdownFilePair(env.BUCKET, env.DB, { source: { path: 'Reminders/A.md', content: '', expectedHash: first.hash }, destination: { path: 'Reminders/B.md', content, expectedHash: null } });
  if (action === 'rename') { await remove('Reminders/A.md'); await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/B.md', content, null); }
  await drainNotificationProjections(env);
  expect(await command()).toMatchObject({ operation: 'schedule' });
  const { alarm } = await alarmFromCommand();
  await alarm.alarm();
  expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
});

it('does not notify newly imported historical reminders', async () => {
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', note('Historical', new Date(Date.now() - 60_000).toISOString()), null);
  await drainNotificationProjections(env);
  expect(await command()).toMatchObject({ operation: 'cancel' });
});

it('records a missed delivery after the late window instead of sending or silently cancelling', async () => {
  const now = Date.now();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', note('Due', new Date(now + 60_000).toISOString()), null);
  vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60_000);
  await drainNotificationProjections(env);
  const { alarm, state } = await alarmFromCommand();
  await alarm.alarm();
  expect(sendToAllSubscriptions).not.toHaveBeenCalled();
  expect(await state.storage.getAlarm()).toBeNull();
  expect(await (await handleDiagnostics(env.DB)).json()).toMatchObject({ counts: { failedNotificationDeliveries: 1 } });
});

it.each(['A', 'Z'])('quarantines duplicate ownership, rejects edits, and resumes after repair (original %s)', async original => {
  const originalPath = `Reminders/${original}.md`;
  const duplicatePath = 'Reminders/M.md';
  const due = '2099-01-02T10:00:00.000Z';
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, originalPath, note('Original', due), null);
  await drainNotificationProjections(env);
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, duplicatePath, note('Copied and completed', due, true), null);
  await drainNotificationProjections(env);
  expect(await command()).toMatchObject({ operation: 'schedule' });
  expect(await env.DB.prepare('SELECT file_path FROM reminder_projections WHERE reminder_id = ?').bind(id).first()).toMatchObject({ file_path: originalPath });
  const listing = await list() as { reminders: unknown[]; issues: Array<{ path: string; reason: string }> };
  expect(listing.reminders).toEqual([]);
  expect(listing.issues.map(issue => issue.path).sort()).toEqual([originalPath, duplicatePath].sort());
  for (const issue of listing.issues) expect(issue.reason).toContain('Duplicate');
  await expect(loadReminderSource(env, 'Reminders', id, originalPath)).rejects.toThrow('Duplicate');
  await remove(duplicatePath);
  await drainNotificationProjections(env);
  expect((await env.DB.prepare('SELECT last_error FROM notification_projection_jobs WHERE last_error IS NOT NULL').all()).results).toEqual([]);
  expect(await command()).toMatchObject({ operation: 'schedule' });
  expect(await list()).toMatchObject({ reminders: [{ id, filePath: originalPath }], issues: [] });
});
