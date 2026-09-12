/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex } from './auth';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol';
import { createReminderOperationId } from '@/protocol/reminder-operation';

beforeEach(async () => {
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('device', ?, 'vault')")
    .bind(await sha256Hex('event-token')).run();
  // Ordinary scheduling tests start after the one-time legacy storage migration.
  await env.DB.prepare("INSERT INTO maintenance_state(key, value) VALUES ('legacy_orphan_sweep_done', '1')").run();
});
afterEach(async () => { await reset(); });

it('processes a saved reminder without cron and leaves both coordinators idle', async () => {
  const request = (path: string, init: RequestInit) => worker.fetch(new Request(`https://event.test${path}`, {
    ...init, headers: { Authorization: 'Bearer event-token', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), ...init.headers },
  }), env);
  expect((await request('/reminders/notification-policy', { method: 'POST', body: JSON.stringify({
    folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00',
  }) })).status).toBe(200);
  const id = '11111111-1111-4111-8111-111111111111';
  expect((await request('/sync/upload?path=Reminders/Inbox.md', { method: 'PUT',
    headers: { 'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)) },
    body: `- [ ] Due @2099-01-02T10:00:00.000Z <!-- crate-id:${id} -->`,
  })).status).toBe(200);

  const coordinator = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
  await coordinator.fetch('https://do/ensure', { method: 'POST' });
  for (let pass = 0; pass < 5; pass++) {
    await runDurableObjectAlarm(coordinator);
    // This request shares the coordinator lock, so any in-flight pass finishes first.
    await coordinator.fetch('https://do/ensure', { method: 'POST' });
  }
  expect(await env.DB.prepare('SELECT reminder_id FROM scheduled_reminders WHERE reminder_id = ?').bind(id).first())
    .toEqual({ reminder_id: id });
  expect(await env.DB.prepare('SELECT 1 FROM notification_jobs LIMIT 1').first()).toBeNull();
  expect(await runInDurableObject(coordinator, (_instance, state) => state.storage.getAlarm())).toBeNull();
  expect(await runDurableObjectAlarm(coordinator)).toBe(false);

  const maintenance = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/maintenance'));
  expect(await runDurableObjectAlarm(maintenance)).toBe(true);
  expect(await runInDurableObject(maintenance, (_instance, state) => state.storage.getAlarm())).toBeNull();
  expect(await runDurableObjectAlarm(maintenance)).toBe(false);
  const reminder = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName(id));
  expect(await runInDurableObject(reminder, (_instance, state) => state.storage.getAlarm()))
    .toBe(Date.parse('2099-01-02T10:00:00.000Z'));
});

it('does not wake notifications for settings or binary uploads', async () => {
  const headers = { Authorization: 'Bearer event-token', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current) };
  expect((await worker.fetch(new Request('https://event.test/settings', {
    method: 'PUT', headers, body: JSON.stringify({ expectedVersion: null, settings: {
      ignorePatterns: [], syncOnStartup: true, syncOnResume: true, syncInterval: 60, showStatusBar: true, pushEnabled: false,
    } }),
  }), env)).status).toBe(200);
  expect((await worker.fetch(new Request('https://event.test/sync/upload?path=image.bin', {
    method: 'PUT', headers: { ...headers, 'X-Crate-Expected-Hash': 'absent',
      'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)) }, body: 'bytes',
  }), env)).status).toBe(200);
  const coordinator = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
  expect(await runInDurableObject(coordinator, (_instance, state) => state.storage.getAlarm())).toBeNull();
});
