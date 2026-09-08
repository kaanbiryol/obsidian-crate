/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { writeCommittedMarkdownFile } from './storage';
import { sha256Hex } from './auth';
import { drainNotificationProjections } from './notification-projection';
import { revalidateReminderSources } from './reminder-source-migration';
import { handleNotificationPolicy } from './notification-policy';
import { ReminderAlarm } from './notifications/reminder-alarm';
import { sendToAllSubscriptions } from './notifications/push';
import { REMINDER_CACHE_PARSER_VERSION } from './reminders-web/reminder-cache/types';
import { runNotificationCoordinator } from './notification-coordinator';
import type { Env } from './types';

vi.mock('./notifications/push', () => ({ listPushSubscriptionIds: vi.fn(async () => ['sub']), sendToAllSubscriptions: vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0, quarantined: 0, errors: [], failedSubscriptionIds: [] })) }));
beforeEach(async () => {
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: null }) }), env.DB);
});
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await reset(); });
const id = '11111111-1111-4111-8111-111111111111';
const path = 'Reminders/Inbox.md';
const note = (due: string) => `- [ ] Scheduled @${due} <!-- crate-id:${id} -->`;
function state() {
  const values = new Map<string, unknown>(); let alarmTime: number | null = null;
  return { storage: { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); }, delete: async (key: string) => values.delete(key), getAlarm: async () => alarmTime, setAlarm: async (value: number | Date) => { alarmTime = Number(value); }, deleteAlarm: async () => { alarmTime = null; } } };
}
async function command() {
  return env.DB.prepare('SELECT job_token, operation, payload_json FROM notification_jobs WHERE reminder_id = ?').bind(id).first<{ job_token: string; operation: string; payload_json: string }>();
}
async function sendCommand(alarm: ReminderAlarm) {
  const job = (await command())!;
  return alarm.fetch(job.operation === 'cancel'
    ? new Request(`https://do/cancel?reminderId=${id}&jobToken=${job.job_token}`, { method: 'DELETE' })
    : new Request('https://do/schedule', { method: 'PUT', body: JSON.stringify({ ...JSON.parse(job.payload_json), jobToken: job.job_token }) }));
}
async function legacy(content?: (valid: string) => string) {
  const due = new Date(Date.now() + 60_000).toISOString();
  const valid = note(due);
  const published = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, valid, null);
  const row = await env.DB.prepare('SELECT storage_key FROM files WHERE path = ?').bind(path).first<{ storage_key: string }>();
  const file = { ...published, storageKey: row!.storage_key };
  await drainNotificationProjections(env);
  const alarmState = state(); const alarm = new ReminderAlarm(alarmState as never, env);
  expect((await sendCommand(alarm)).status).toBe(200);
  if (content) {
    // Construct an older-parser snapshot: these verified bytes were interpreted
    // as an active reminder by that build, with its existing source/schedule rows.
    const bytes = content(valid);
    await env.BUCKET.put(file.storageKey, bytes);
    await env.DB.prepare('UPDATE files SET hash = ?, size = ? WHERE path = ?').bind(await sha256Hex(bytes), new TextEncoder().encode(bytes).length, path).run();
  }
  await env.DB.prepare('UPDATE reminder_source_state SET parser_version = ?').bind(REMINDER_CACHE_PARSER_VERSION - 1).run();
  return { due, valid, file, alarm, alarmState };
}

it('blocks old queued and installed ghost schedules, then conclusively cancels them without changing bytes', async () => {
  const h = await legacy(text => `\`\`\`markdown\n${text}\n\`\`\``);
  await env.DB.prepare('DELETE FROM reminder_source_state').run(); // Schema-3 deployments have no authority rows.
  await h.alarm.alarm();
  expect(sendToAllSubscriptions).not.toHaveBeenCalled();
  expect((await sendCommand(new ReminderAlarm(state() as never, env))).status).toBe(409);
  expect(await revalidateReminderSources(env, 3)).toBe(false);
  await drainNotificationProjections(env);
  expect(await command()).toMatchObject({ operation: 'cancel' });
  expect((await env.DB.prepare('SELECT * FROM reminder_sources').all()).results).toEqual([]);
  expect((await sendCommand(h.alarm)).status).toBe(200);
  await h.alarm.alarm();
  expect(sendToAllSubscriptions).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT * FROM scheduled_reminders').first()).toBeNull();
  expect(await (await env.BUCKET.get(h.file.storageKey))?.text()).toBe(`\`\`\`markdown\n${h.valid}\n\`\`\``);
  expect((await env.DB.prepare('SELECT * FROM changelog').all()).results).toHaveLength(1);
});

it('preserves first observation and resumes a genuine occurrence delayed across its deadline', async () => {
  const h = await legacy();
  const observed = await env.DB.prepare('SELECT first_seen_at FROM reminder_occurrences').first();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(h.due) + 60_000);
  await h.alarm.alarm();
  expect(sendToAllSubscriptions).not.toHaveBeenCalled();
  await revalidateReminderSources(env, 3);
  await drainNotificationProjections(env);
  expect(await env.DB.prepare('SELECT first_seen_at FROM reminder_occurrences').first()).toEqual(observed);
  expect(await command()).toMatchObject({ operation: 'schedule' });
  expect((await sendCommand(h.alarm)).status).toBe(200);
  await h.alarm.alarm();
  expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
});

it('quarantines uncertain legacy metadata and permits repair without deriving cancellations', async () => {
  const h = await legacy(text => `${text}\n<!-- crate-desc:v1:%invalid -->`);
  const prior = await command();
  await revalidateReminderSources(env, 3);
  await drainNotificationProjections(env);
  expect(await command()).toEqual(prior);
  expect(await env.DB.prepare('SELECT verified, parser_version FROM reminder_source_state').first()).toEqual({ verified: 0, parser_version: REMINDER_CACHE_PARSER_VERSION });
  expect(await env.DB.prepare('SELECT last_error FROM notification_projection_jobs').first()).toMatchObject({ last_error: expect.stringContaining('Repair') as string });
  await h.alarm.alarm();
  expect(sendToAllSubscriptions).not.toHaveBeenCalled();
  const file = await env.DB.prepare('SELECT hash FROM files WHERE path = ?').bind(path).first<{ hash: string }>();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, h.valid, file!.hash);
  await drainNotificationProjections(env);
  expect(await command()).toMatchObject({ operation: 'schedule' });
  expect((await sendCommand(h.alarm)).status).toBe(200);
});

it('bounds R2 reparsing to 2 MiB and resumes source migration in later invocations', async () => {
  const text = 'a'.repeat(900 * 1024);
  for (let index = 0; index < 5; index++) await writeCommittedMarkdownFile(env.BUCKET, env.DB, `Notes/${index}.md`, text, null);
  await env.DB.prepare('UPDATE reminder_source_state SET parser_version = 0').run();
  const get = vi.spyOn(env.BUCKET, 'get');
  expect(await revalidateReminderSources(env, 4)).toBe(true);
  expect(get).toHaveBeenCalledTimes(2);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_source_state WHERE parser_version = ?').bind(REMINDER_CACHE_PARSER_VERSION).first()).toEqual({ count: 2 });
  get.mockClear();
  expect(await revalidateReminderSources(env, 4)).toBe(true);
  expect(get).toHaveBeenCalledTimes(2);
  expect(await revalidateReminderSources(env, 4)).toBe(false);
});

it('does not publish a parsed older revision over a concurrent new file commit', async () => {
  const h = await legacy();
  const get = env.BUCKET.get.bind(env.BUCKET);
  const replacement = h.valid.replace('Scheduled', 'Edited while migrating');
  vi.spyOn(env.BUCKET, 'get').mockImplementationOnce(async (...args) => {
    const old = await get(...args);
    await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, replacement, h.file.hash);
    return old;
  });
  await revalidateReminderSources(env, 3);
  await drainNotificationProjections(env);
  expect(await command()).toMatchObject({ payload_json: expect.stringContaining('Edited while migrating') as string });
  const current = await env.DB.prepare('SELECT storage_key FROM files WHERE path = ?').bind(path).first<{ storage_key: string }>();
  expect(await env.DB.prepare('SELECT file_revision, verified FROM reminder_source_state WHERE file_path = ?').bind(path).first()).toEqual({ file_revision: current!.storage_key, verified: 1 });
});

it('upgrades schema 3 additively and discovers unchanged sources in resumable indexed pages without a policy', async () => {
  await env.DB.prepare('DELETE FROM notification_policy').run();
  await env.DB.prepare('DROP TABLE reminder_source_state').run();
  await env.DB.prepare('UPDATE crate_schema SET version = 3').run();
  const hash = await sha256Hex('');
  const files = Array.from({ length: 105 }, (_, index) => ({ path: `Notes/${String(index).padStart(3, '0')}.md`, key: `__uploads__/migration-${index}` }));
  for (const file of files) await env.BUCKET.put(file.key, '');
  await env.DB.prepare(`INSERT INTO files (path, portable_path, storage_key, hash, size)
    SELECT json_extract(value, '$.path'), lower(json_extract(value, '$.path')), json_extract(value, '$.key'), ?, 0 FROM json_each(?)`)
    .bind(hash, JSON.stringify(files)).run();
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  expect(await env.DB.prepare('SELECT version FROM crate_schema').first()).toEqual({ version: 4 });
  expect(await revalidateReminderSources(env, 4)).toBe(true);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_source_state').first()).toEqual({ count: 100 });
  expect(await env.DB.prepare("SELECT value FROM maintenance_state WHERE key = 'reminder_source_scan'").first()).toEqual({ value: 'Notes/099.md' });
  let pending = await revalidateReminderSources(env, 4);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_source_state').first()).toEqual({ count: 105 });
  for (let attempt = 0; attempt < 30 && pending; attempt++) pending = await revalidateReminderSources(env, 4);
  expect(pending).toBe(false);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_source_state WHERE verified = 1 AND parser_version = ?').bind(REMINDER_CACHE_PARSER_VERSION).first()).toEqual({ count: 105 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM files').first()).toEqual({ count: 105 });
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT path FROM files WHERE lower(path) LIKE '%.md' AND path > ? ORDER BY path LIMIT 100").bind('').all();
  expect(JSON.stringify(plan.results)).toContain('files_markdown_path_idx');
});

it('retains genuine duplicate quarantine while an older parser source is revalidated', async () => {
  const h = await legacy();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Copy.md', h.valid, null);
  await env.DB.prepare('UPDATE reminder_source_state SET parser_version = 0').run();
  await revalidateReminderSources(env, 3);
  await drainNotificationProjections(env);
  expect((await env.DB.prepare('SELECT last_error FROM notification_projection_jobs').all()).results).toHaveLength(2);
  expect(JSON.stringify((await env.DB.prepare('SELECT last_error FROM notification_projection_jobs').all()).results)).toContain('Duplicate');
  await h.alarm.alarm();
  expect(sendToAllSubscriptions).not.toHaveBeenCalled();
});

it('bounds combined migration, projection and alarm dispatch and resumes every remaining job', async () => {
  const due = new Date(Date.now() + 600_000).toISOString();
  for (let file = 0; file < 3; file++) {
    const content = Array.from({ length: 3 }, () => `- [ ] Pending @${due} <!-- crate-id:${crypto.randomUUID()} -->`).join('\n');
    await writeCommittedMarkdownFile(env.BUCKET, env.DB, `Reminders/${file}.md`, content, null);
  }
  await env.DB.prepare('UPDATE reminder_source_state SET parser_version = 0').run();
  const alarms = new Map<string, ReminderAlarm>();
  // Invoke the real alarm with the same D1 handle so this conservative count
  // also includes SQL that would run in separate Durable Object invocations.
  const runtime = { ...env, REMINDER_ALARMS: {
    idFromName: (name: string) => name,
    get(name: string) {
      if (!alarms.has(name)) alarms.set(name, new ReminderAlarm(state() as never, env));
      return { fetch: (input: string, init?: RequestInit) => alarms.get(name)!.fetch(new Request(input, init)) };
    },
  } } as unknown as Env;
  const prepare = vi.spyOn(env.DB, 'prepare');
  for (let pass = 0; pass < 6; pass++) {
    prepare.mockClear();
    await runNotificationCoordinator(state() as never, runtime);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(50);
  }
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_source_state WHERE verified = 1 AND parser_version = ?')
    .bind(REMINDER_CACHE_PARSER_VERSION).first()).toEqual({ n: 3 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM scheduled_reminders').first()).toEqual({ n: 9 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM notification_jobs').first()).toEqual({ n: 0 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM notification_projection_jobs').first()).toEqual({ n: 0 });
});
