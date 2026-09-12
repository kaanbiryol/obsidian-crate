/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { READY_PROJECTION_JOBS_SQL, NEXT_NOTIFICATION_WORK_SQL } from './notification-queue';
import { runNotificationCoordinator } from './notification-coordinator';
import { revalidateReminderSources } from './reminder-source-migration';
import { REMINDER_CACHE_PARSER_VERSION } from './reminders-web/reminder-cache/types';
import { writeCommittedMarkdownFile } from './storage';
import { ReminderAlarm } from './notifications/reminder-alarm';

beforeEach(async () => {
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

type MeasuredRows = { results: Record<string, unknown>[]; meta: { rows_read: number } };

const oldSelection = "SELECT path, job_token FROM notification_projection_jobs WHERE last_error IS NULL OR updated_at < datetime('now', '-1 hour') ORDER BY updated_at, path LIMIT ?";
const oldCounts = `SELECT
  (SELECT COUNT(*) FROM notification_projection_jobs) + (SELECT COUNT(*) FROM notification_jobs) AS count,
  (SELECT COUNT(*) FROM notification_projection_jobs WHERE last_error IS NULL) +
  (SELECT COUNT(*) FROM notification_jobs WHERE available_at <= ?) AS ready`;

it.each([2000, 10000])('uses bounded row reads to select work from %i queued files', async count => {
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO notification_projection_jobs(path, job_token) SELECT 'note-'||x, 'token-'||x FROM n`).bind(count).run();
  const before = await env.DB.prepare(oldSelection).bind(1).all() as MeasuredRows;
  const beforeCounts = await env.DB.prepare(oldCounts).bind(Date.now()).all() as MeasuredRows;
  const after = await env.DB.prepare(READY_PROJECTION_JOBS_SQL).bind(1, 1, 1).all() as MeasuredRows;
  const next = await env.DB.prepare(NEXT_NOTIFICATION_WORK_SQL).all() as MeasuredRows;
  expect(after.results).toEqual(before.results);
  const oldReads = before.meta.rows_read + beforeCounts.meta.rows_read;
  const newReads = after.meta.rows_read + next.meta.rows_read;
  if (count === 2000) expect({ oldReads, newReads }).toMatchInlineSnapshot(`
    {
      "newReads": 6,
      "oldReads": 8001,
    }
  `);
  expect(newReads).toBeLessThanOrEqual(10);
  expect(newReads).toBeLessThan(oldReads / 100);

  // A queue full of failures that are not due must be equally cheap.
  await env.DB.prepare("UPDATE notification_projection_jobs SET last_error = 'temporary failure'").run();
  await env.DB.prepare(`INSERT INTO notification_file_retries(path, attempts, available_at, error)
    SELECT path, 1, ?, last_error FROM notification_projection_jobs`).bind(Date.now() + 3600_000).run();
  const sleeping = await env.DB.prepare(READY_PROJECTION_JOBS_SQL).bind(1, 1, 1).all() as MeasuredRows;
  const retry = await env.DB.prepare(NEXT_NOTIFICATION_WORK_SQL).all() as MeasuredRows;
  expect(sleeping.results).toEqual([]);
  expect(sleeping.meta.rows_read + retry.meta.rows_read).toBeLessThanOrEqual(10);
});

it('selects both ready and due retry work without starving either', async () => {
  await env.DB.prepare(`INSERT INTO notification_projection_jobs(path, job_token, last_error, updated_at) VALUES
    ('ready', '1', NULL, datetime('now')),
    ('due', '2', 'retry', datetime('now', '-2 hours')),
    ('later', '3', 'retry', datetime('now'))`).run();
  await env.DB.prepare(`INSERT INTO notification_file_retries(path, attempts, available_at, error)
    SELECT path, 1, (unixepoch(updated_at) + 3600)*1000, last_error FROM notification_projection_jobs WHERE last_error IS NOT NULL`).run();
  expect((await env.DB.prepare(READY_PROJECTION_JOBS_SQL).bind(2, 2, 2).all()).results)
    .toEqual([{ path: 'due', job_token: '2' }, { path: 'ready', job_token: '1' }]);
});

it('finishes migration once and performs no file scan or writes on subsequent idle runs', async () => {
  expect(await revalidateReminderSources(env, 2)).toBe(false);
  const prepare = vi.spyOn(env.DB, 'prepare');
  const setAlarm = vi.fn();
  for (let pass = 0; pass < 3; pass++) await runNotificationCoordinator({ storage: { setAlarm } } as never, env);
  const sql = prepare.mock.calls.map(([query]) => query);
  expect(sql.some(query => query.includes('SELECT path FROM files'))).toBe(false);
  expect(sql.some(query => /INSERT|UPDATE|DELETE|COUNT\(\*\)/.test(query))).toBe(false);
  expect(setAlarm).not.toHaveBeenCalled();
});

it('sleeps until failed work is due instead of waking every minute', async () => {
  await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
  await env.DB.prepare("INSERT INTO notification_projection_jobs(path, job_token, last_error) VALUES ('failed', 'token', 'temporary failure')").run();
  await env.DB.prepare(`INSERT INTO notification_file_retries(path, attempts, available_at, error) VALUES ('failed', 1, ?, 'temporary failure')`).bind(Date.now() + 3600_000).run();
  const retry = await env.DB.prepare(NEXT_NOTIFICATION_WORK_SQL).first<{ projectionRetry: number }>();
  const setAlarm = vi.fn();
  await runNotificationCoordinator({ storage: { setAlarm } } as never, env);
  expect(setAlarm).toHaveBeenCalledExactlyOnceWith(retry!.projectionRetry);
  expect(retry!.projectionRetry - Date.now()).toBeGreaterThan(3500_000);
});

it('brings a delayed coordinator alarm forward when new changes arrive', async () => {
  const setAlarm = vi.fn(async (_time: number) => {});
  const state = { storage: { put: vi.fn(async () => {}),
    getAlarm: async () => Date.now() + 3600_000, setAlarm } };
  const alarm = new ReminderAlarm(state as never, env);
  const before = Date.now();
  await alarm.fetch(new Request('https://do/project', { method: 'POST' }));
  expect(setAlarm).toHaveBeenCalledOnce();
  expect(setAlarm.mock.calls[0]![0]).toBeGreaterThanOrEqual(before);
  expect(setAlarm.mock.calls[0]![0]).toBeLessThanOrEqual(Date.now() + 1000);
});

it('does not let an older parser completion marker suppress a new migration', async () => {
  await env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)')
    .bind(`reminder_source_scan_v${REMINDER_CACHE_PARSER_VERSION - 1}`, '').run();
  const prepare = vi.spyOn(env.DB, 'prepare');
  await revalidateReminderSources(env, 2);
  expect(prepare.mock.calls.some(([query]) => query.includes('SELECT path FROM files'))).toBe(true);
});

it('handles new file changes after migration without rescanning the vault', async () => {
  await revalidateReminderSources(env, 2);
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/new.md',
    '- [ ] New @2099-01-01T12:00:00.000Z <!-- crate-id:11111111-1111-4111-8111-111111111111 -->', null);
  const prepare = vi.spyOn(env.DB, 'prepare');
  expect(await revalidateReminderSources(env, 2)).toBe(false);
  expect(prepare.mock.calls.some(([sql]) => sql.includes('SELECT path FROM files'))).toBe(false);
  expect(await env.DB.prepare('SELECT path FROM notification_projection_jobs').first()).toEqual({ path: 'Reminders/new.md' });
});

it('drains deleted legacy source rows after the migration scan has completed', async () => {
  await revalidateReminderSources(env, 2);
  await env.DB.prepare(`INSERT INTO reminder_source_state(file_path, file_revision, parser_version, verified)
    VALUES ('deleted-1.md', 'old', 0, 0), ('deleted-2.md', 'old', 0, 0), ('deleted-3.md', 'old', 0, 0)`).run();
  expect(await revalidateReminderSources(env, 2)).toBe(true);
  expect(await revalidateReminderSources(env, 2)).toBe(false);
  expect((await env.DB.prepare('SELECT file_path FROM reminder_source_state').all()).results).toEqual([]);
});
