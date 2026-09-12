/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { writeCommittedMarkdownFile } from './storage';
import { revalidateReminderSources } from './reminder-source-migration';
import { drainNotificationJobs } from './notification-outbox';
import { retryPausedNotifications } from './notification-retry-handler';
import { handleDiagnostics } from './maintenance/diagnostics';
import { READY_PROJECTION_JOBS_SQL, NEXT_NOTIFICATION_WORK_SQL } from './notification-queue';

beforeEach(async () => {
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { await reset(); });

it('pauses an invalid file immediately despite unrelated edits, then supports explicit retry and repair', async () => {
  const path = 'Reminders/Broken.md';
  const content = '- [ ] Broken @2099-01-01 <!-- crate-id:11111111-1111-4111-8111-111111111111 -->\n<!-- crate-desc:v1:%invalid -->';
  const original = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
  const failure = () => env.DB.prepare('SELECT attempts, available_at FROM notification_file_retries WHERE path = ?').bind(path).first();
  expect(await failure()).toEqual({ attempts: 1, available_at: -1 });
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Unrelated.md', 'Hello', null);
  for (let i = 0; i < 3; i++) await revalidateReminderSources(env, 2);
  expect(await failure()).toEqual({ attempts: 1, available_at: -1 });
  expect(await (await handleDiagnostics(env.DB)).json()).toMatchObject({ pausedNotificationFiles: [{ path, attempts: 1 }] });
  expect(await (await retryPausedNotifications(env.DB)).json()).toEqual({ retried: 1, more: false });
  await revalidateReminderSources(env, 2);
  expect(await failure()).toMatchObject({ attempts: 1 });
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, 'Repaired', original.hash);
  expect(await failure()).toBeNull();
});

it('stops dispatching a broken alarm job after eight failures', async () => {
  await env.DB.prepare(`INSERT INTO notification_jobs(reminder_id, job_token, operation, available_at) VALUES ('broken', 'token', 'cancel', 0)`).run();
  let requests = 0;
  const failing = { ...env, REMINDER_ALARMS: { idFromName: () => '', get: () => ({ fetch: async () => {
    requests++; return new Response(null, { status: 503 });
  } }) } } as never;
  for (let i = 0; i < 8; i++) {
    await env.DB.prepare('UPDATE notification_jobs SET available_at = 0 WHERE available_at >= 0').run();
    await drainNotificationJobs(failing);
  }
  for (let i = 0; i < 3; i++) await drainNotificationJobs(failing);
  expect(requests).toBe(8);
  expect(await env.DB.prepare('SELECT attempts, available_at FROM notification_jobs').first()).toEqual({ attempts: 8, available_at: -1 });
  await retryPausedNotifications(env.DB);
  await drainNotificationJobs(failing);
  expect(requests).toBe(9);
});

it.each([null, -1])('does not scan ten thousand paused files looking for runnable work (deadline=%s)', async deadline => {
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10000)
    INSERT INTO notification_projection_jobs(path, job_token, last_error) SELECT 'note-'||x, 'token', 'failed' FROM n`).run();
  await env.DB.prepare(`INSERT INTO notification_file_retries(path, attempts, available_at, error)
    SELECT path, 8, ?, 'failed' FROM notification_projection_jobs`).bind(deadline).run();
  const selected = await env.DB.prepare(READY_PROJECTION_JOBS_SQL).bind(1, 1, 1).all() as unknown as { results: unknown[]; meta: { rows_read: number } };
  const next = await env.DB.prepare(NEXT_NOTIFICATION_WORK_SQL).all() as unknown as { meta: { rows_read: number } };
  expect(selected.results).toEqual([]);
  expect(selected.meta.rows_read + next.meta.rows_read).toBeLessThanOrEqual(10);
});

it('still gives temporary storage failures eight attempts', async () => {
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Note.md', 'Hello', null);
  const source = await env.DB.prepare('SELECT storage_key FROM files WHERE path = ?').bind('Note.md').first<{ storage_key: string }>();
  await env.BUCKET.delete(source!.storage_key);
  await env.DB.prepare("UPDATE reminder_source_state SET verified = 0 WHERE file_path = 'Note.md'").run();
  await env.DB.prepare("INSERT INTO notification_file_retries(path, attempts, available_at, error) VALUES ('Note.md', 0, 0, 'temporary')").run();
  for (let i = 0; i < 8; i++) {
    await env.DB.prepare('UPDATE notification_file_retries SET available_at = 0 WHERE available_at >= 0').run();
    await revalidateReminderSources(env, 2);
  }
  expect(await env.DB.prepare('SELECT attempts, available_at FROM notification_file_retries').first()).toEqual({ attempts: 8, available_at: null });
});
