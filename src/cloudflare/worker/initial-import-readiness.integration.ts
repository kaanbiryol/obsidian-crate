/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { INITIAL_REMINDERS_PENDING, finishInitialReminderSetup } from './initial-import-readiness';
import { runNotificationCoordinator } from './notification-coordinator';
import { writeCommittedMarkdownFile } from './storage';
import { handleNotificationPolicy } from './notification-policy';
import { meterD1Writes } from './d1-write-meter-test-harness';
import { SyncTestDevice } from './sync-engine-test-harness';
import { REMINDER_CACHE_PARSER_VERSION } from './reminders-web/reminder-cache/types';

const clients: SyncTestDevice[] = [];
const json = (body: unknown) => new Request('https://test', { method: 'POST', body: JSON.stringify(body) });
const note = (due: string, id = crypto.randomUUID()) => `- [ ] Task @${due} <!-- crate-id:${id} -->`;
beforeEach(async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  for (const sql of schema.split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  await handleNotificationPolicy(json({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: null }), env.DB);
});
afterEach(async () => { for (const client of clients.splice(0)) client.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

async function pendingImport() {
  await env.DB.prepare("INSERT INTO initial_import(id, token, state, snapshot_seq) VALUES (1, 'import', 'complete', 1)").run();
  await env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)').bind(INITIAL_REMINDERS_PENDING, 'import').run();
}
const readiness = async (db = env.DB) => (await finishInitialReminderSetup(json({ token: 'import' }), db)).json() as Promise<{ ready: boolean; error?: string }>;
const pass = () => runNotificationCoordinator({ storage: { setAlarm: vi.fn() } } as never, env);

it('keeps readiness pending until every schedule is installed and writes nothing on pending probes', async () => {
  await pendingImport();
  const content = Array.from({ length: 12 }, () => note('2099-01-01T12:00:00.000Z')).join('\n');
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/tasks.md', content, null);
  const meter = meterD1Writes(env.DB);
  expect(await readiness(meter.db)).toMatchObject({ ready: false });
  expect(meter.writes()).toBe(0);
  await pass();
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM scheduled_reminders').first()).toEqual({ n: 10 });
  expect(await readiness(meter.db)).toMatchObject({ ready: false, progress: { scanning: false, remainingFiles: 0, remainingSchedules: 2 } });
  expect(meter.writes()).toBe(0);
  await pass(); await pass();
  expect(await readiness(meter.db)).toEqual({ ready: true });
  expect(meter.writes()).toBe(1);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM scheduled_reminders').first()).toEqual({ n: 12 });
  expect(await readiness(meter.db)).toEqual({ ready: true });
  expect(meter.writes()).toBe(1);
});

it('reports a reminder failure without acknowledging setup or deleting uploaded bytes', async () => {
  await pendingImport();
  const id = crypto.randomUUID();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/duplicate.md',
    [note('2099-01-01T12:00:00.000Z', id), note('2099-01-01T12:00:00.000Z', id)].join('\n'), null);
  await pass();
  const status = await readiness();
  expect(status.ready).toBe(false); expect(status.error).toMatch(/duplicate/i);
  expect(await env.DB.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(INITIAL_REMINDERS_PENDING).first()).not.toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM files WHERE portable_path = 'reminders/duplicate.md'").first()).not.toBeNull();
});

it('does not create catch-up schedules for reminders already overdue when indexed', async () => {
  await pendingImport();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/overdue.md', note('2020-01-01T12:00:00.000Z'), null);
  await pass();
  expect(await readiness()).toEqual({ ready: true });
  expect(await env.DB.prepare('SELECT 1 FROM scheduled_reminders').first()).toBeNull();
});

it('probes ten thousand verified files with bounded reads', async () => {
  await pendingImport();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10000)
    INSERT INTO reminder_source_state(file_path, file_revision, parser_version, verified)
    SELECT 'Reminders/'||x||'.md', 'key-'||x, ?, 1 FROM n`).bind(REMINDER_CACHE_PARSER_VERSION).run();
  await env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)')
    .bind(`reminder_source_scan_portable_v${REMINDER_CACHE_PARSER_VERSION}:Reminders`, '').run();
  const batch = env.DB.batch.bind(env.DB);
  let reads = 0;
  vi.spyOn(env.DB, 'batch').mockImplementation(async statements => {
    const results = await batch(statements);
    reads += (results as Array<{ meta: { rows_read: number } }>).reduce((sum, result) => sum + result.meta.rows_read, 0);
    return results;
  });
  expect(await readiness()).toEqual({ ready: true });
  expect(reads).toBeLessThan(30);
});

it.each([false, true])('resumes reminder setup and syncs a local repair before waiting (repair=%s)', async repair => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const device = new SyncTestDevice('reminder-setup-restart', env); clients.push(device);
  await device.authorize(); await device.open();
  await device.disk.vault.createFolder('Reminders'); await device.disk.vault.createFolder('Notes');
  const content = Array.from({ length: 12 }, () => note('2099-01-01T12:00:00.000Z')).join('\n');
  const duplicate = note('2099-01-01T12:00:00.000Z');
  device.disk.write('Reminders/tasks.md', repair ? `${duplicate}\n${duplicate}` : content);
  device.disk.write('Notes/ignored.md', content);
  vi.spyOn(device.api.initialImport, 'waitUntilReady').mockRejectedValueOnce(new Error('offline during reminder setup'));
  const interrupted = await device.engine.initialSync();
  expect(interrupted.errors).toEqual(['offline during reminder setup']);
  expect(interrupted).toMatchObject({ success: false, uploaded: 2 });
  if (repair) {
    await pass();
    expect(await env.DB.prepare('SELECT 1 FROM notification_file_retries').first()).not.toBeNull();
    device.disk.write('Reminders/tasks.md', content);
  }
  device.close(); await device.open();
  const put = vi.spyOn(env.BUCKET, 'put');
  const upload = vi.spyOn(device.api.initialImport, 'upload');
  const resumed = device.engine.sync();
  await vi.waitFor(() => expect(device.engine.getState().work?.phase).toBe('reminders'));
  expect(device.engine.getState().status).toBe('syncing');
  const coordinator = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
  for (let i = 0; i < 5; i++) await runDurableObjectAlarm(coordinator);
  expect((await resumed).success).toBe(true);
  expect(upload).not.toHaveBeenCalled(); expect(put).toHaveBeenCalledTimes(repair ? 1 : 0);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM scheduled_reminders').first()).toEqual({ n: 12 });
  expect((await env.DB.prepare('SELECT file_path FROM reminder_source_state').all()).results).toEqual([{ file_path: 'Reminders/tasks.md' }]);
}, 15_000);

it('keeps first-time sync active until the reminder schedule is ready', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const device = new SyncTestDevice('fresh-reminder-setup', env); clients.push(device);
  await device.authorize(); await device.open(); await device.disk.vault.createFolder('Reminders');
  device.disk.write('Reminders/task.md', note('2099-01-01T12:00:00.000Z'));
  const syncing = device.engine.initialSync();
  await vi.waitFor(() => expect(device.engine.getState().work?.phase).toBe('reminders'));
  expect(device.engine.getState().status).toBe('syncing');
  const coordinator = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
  await runDurableObjectAlarm(coordinator);
  expect((await syncing).success).toBe(true);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM scheduled_reminders').first()).toEqual({ n: 1 });
}, 15_000);

it('preserves initial uploads when reminder settings fail and resumes without uploading those bytes again', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  await env.DB.prepare('DELETE FROM notification_policy').run();
  const device = new SyncTestDevice('initial-policy-retry', env); clients.push(device);
  await device.authorize(); await device.open(); await device.disk.vault.createFolder('Reminders');
  device.disk.write('Reminders/task.md', note('2099-01-01T12:00:00.000Z'));
  device.engine.setReminderScopePreparation(async () => { throw new Error('reminder settings unavailable'); });
  const interrupted = await device.engine.initialSync();
  expect(interrupted).toMatchObject({ success: false, uploaded: 1, errors: ['reminder settings unavailable'] });
  expect(await env.DB.prepare('SELECT state FROM initial_import').first()).toEqual({ state: 'importing' });
  expect(await env.DB.prepare("SELECT 1 FROM files WHERE portable_path = 'reminders/task.md'").first()).not.toBeNull();

  device.close(); await device.open();
  device.engine.setReminderScopePreparation(async () => {
    await device.api.ensureNotificationPolicy({ enabled: true, folderPath: 'Reminders', timezone: 'UTC', allDayTime: null });
  });
  const put = vi.spyOn(env.BUCKET, 'put');
  const upload = vi.spyOn(device.api.initialImport, 'upload');
  const wait = vi.spyOn(device.api.initialImport, 'waitUntilReady');
  const resumed = device.engine.sync();
  await vi.waitFor(() => expect(wait).toHaveBeenCalled());
  const coordinator = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
  await runDurableObjectAlarm(coordinator);
  expect(await resumed).toMatchObject({ success: true, uploaded: 0 });
  expect(upload).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM scheduled_reminders').first()).toEqual({ n: 1 });
}, 15_000);

it.each(['failed', 'pending'])('syncs an ordinary edit while reminder settings are %s', async status => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const device = new SyncTestDevice(`incremental-policy-${status}`, env); clients.push(device);
  await device.authorize(); await device.open();
  device.disk.write('note.md', 'original');
  expect((await device.engine.initialSync()).success).toBe(true);
  // Reopening also exercises discovery that this remote already finished initial setup.
  device.close(); await device.open();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const prepare = vi.fn(() => status === 'failed' ? Promise.reject(new Error('settings unavailable')) : pending);
  device.engine.setReminderScopePreparation(prepare);
  device.disk.write('note.md', 'updated');
  try {
    expect(await device.engine.sync()).toMatchObject({ success: true, uploaded: 1 });
    expect(prepare).toHaveBeenCalledOnce();
    expect(device.engine.getState()).toMatchObject({ status: 'idle', lastError: null });
    const stored = await env.DB.prepare("SELECT storage_key FROM files WHERE portable_path = 'note.md'").first<{ storage_key: string }>();
    expect(await (await env.BUCKET.get(stored!.storage_key))!.text()).toBe('updated');
  } finally { release(); }
}, 15_000);

it('finishes 400 newly imported overdue reminders without creating cancellation jobs', async () => {
  await pendingImport();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/history.md',
    Array.from({ length: 400 }, () => note('2020-01-01T12:00:00.000Z')).join('\n'), null);
  const dispatch = vi.spyOn(env.REMINDER_ALARMS, 'get');
  await pass();
  expect(await readiness()).toEqual({ ready: true });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_projections').first()).toEqual({ n: 400 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM notification_jobs').first()).toEqual({ n: 0 });
  // The dispatcher is called once; no per-reminder cancellation objects are opened.
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it.each([false, true])('cancels a completed reminder with an existing alarm or pending schedule (dispatched=%s)', async dispatched => {
  await pendingImport();
  const path = 'Reminders/task.md';
  const content = note('2099-01-01T12:00:00.000Z');
  const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
  const { drainNotificationProjections } = await import('./notification-projection');
  await drainNotificationProjections(env);
  if (dispatched) await pass();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content.replace('[ ]', '[x]'), first.hash);
  await drainNotificationProjections(env);
  expect(await env.DB.prepare('SELECT operation FROM notification_jobs').first()).toEqual({ operation: 'cancel' });
  await pass();
  expect(await env.DB.prepare('SELECT 1 FROM scheduled_reminders').first()).toBeNull();
  expect(await readiness()).toEqual({ ready: true });
});

it('dispatches ten jobs in bounded parallel groups within the request query budget', async () => {
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10)
    INSERT INTO notification_jobs(reminder_id, job_token, operation, available_at)
    SELECT 'parallel-'||x, 'token-'||x, 'cancel', 0 FROM n`).run();
  let active = 0, peak = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.fn(async () => {
    active++; peak = Math.max(peak, active);
    await gate; active--;
    return new Response(null, { status: 204 });
  });
  const prepare = vi.spyOn(env.DB, 'prepare');
  const { drainNotificationJobs } = await import('./notification-outbox');
  const draining = drainNotificationJobs({ ...env, REMINDER_ALARMS: {
    idFromName: (id: string) => id, get: () => ({ fetch }),
  } } as never);
  try { await vi.waitFor(() => expect(active).toBe(5)); }
  finally { release(); await draining; }
  expect(peak).toBe(5);
  expect(fetch).toHaveBeenCalledTimes(10);
  expect(prepare.mock.calls.length).toBeLessThan(50);
  expect(await env.DB.prepare('SELECT 1 FROM notification_jobs').first()).toBeNull();
});
