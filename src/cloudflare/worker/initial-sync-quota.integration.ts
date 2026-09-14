/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { handleBatchUpload } from './sync-batch/upload';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { meterD1Writes } from './d1-write-meter-test-harness';
import { drainNotificationProjections } from './notification-projection';
import { coordinatedNewFiles } from './bulk-upload-dispatch';
import type { BatchUploadResponse } from '@/protocol/sync-types';

afterEach(async () => { await reset(); });
async function initialize(legacy = false) {
  for (let sql of schema.split(';').map(value => value.trim()).filter(Boolean)) {
    if (legacy && !sql.startsWith('CREATE TABLE IF NOT EXISTS staged_upload_batches')) sql = sql.replace(') WITHOUT ROWID', ')');
    await env.DB.prepare(sql).run();
  }
  await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Notes', 'UTC', 'policy')").run();
}
const file = (path: string, content = '# Ordinary note') => ({ path, content: btoa(content), expectedHash: null,
  operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)) });
const request = (files: ReturnType<typeof file>[]) => new Request('https://test/sync/batch-upload', {
  method: 'POST', body: JSON.stringify({ files, bulkNewFiles: true }),
});

it.each([false, true])('bounds initial-upload writes and preserves retries with rowid tables: %s', async legacy => {
  await initialize(legacy);
  // Reapplying the schema must preserve an existing database's table layout.
  await env.DB.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('existing', 'existing', 'existing-key')").run();
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  expect(await env.DB.prepare("SELECT storage_key FROM files WHERE path = 'existing'").first()).toEqual({ storage_key: 'existing-key' });
  const table = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'files'").first<{ sql: string }>();
  expect(table!.sql.includes('WITHOUT ROWID')).toBe(!legacy);

  const meter = meterD1Writes(env.DB);
  const files = Array.from({ length: 8 }, (_, i) => file(`Notes/${i}.md`));
  const result = await (await handleBatchUpload(request(files), env.BUCKET, meter.db)).json() as BatchUploadResponse;
  expect(result.success).toBe(true);
  await drainNotificationProjections({ ...env, DB: meter.db }, 8);
  expect(meter.writes()).toBe(legacy ? 76 : 52);
  expect(await env.DB.prepare('SELECT path FROM notification_projection_jobs').first()).toBeNull();
  const beforeRetry = meter.writes();
  const retry = await (await handleBatchUpload(request(files), env.BUCKET, meter.db)).json() as BatchUploadResponse;
  expect(retry).toEqual(result);
  expect(meter.writes() - beforeRetry).toBe(0);
});

it('keeps cleanup work when a new upload replaces stale reminder state', async () => {
  await initialize();
  await env.DB.prepare(`INSERT INTO reminder_projections(reminder_id, file_path, file_revision, notification_token, policy_revision)
    VALUES ('old-reminder', 'Notes/recreated.md', 'old-revision', 'old-token', 'policy')`).run();
  const result = await (await handleBatchUpload(request([file('Notes/recreated.md')]), env.BUCKET, env.DB)).json() as BatchUploadResponse;
  expect(result.success).toBe(true);
  expect(await env.DB.prepare('SELECT path FROM notification_projection_jobs').first()).toEqual({ path: 'Notes/recreated.md' });
  await drainNotificationProjections(env, 8);
  expect(await env.DB.prepare('SELECT reminder_id FROM reminder_projections').first()).toBeNull();
  expect(await env.DB.prepare('SELECT reminder_id, operation FROM notification_jobs').first())
    .toEqual({ reminder_id: 'old-reminder', operation: 'cancel' });
});

it('passes batch leases through the real reminder coordinator and schedules actual reminders', async () => {
  await initialize();
  const id = '11111111-1111-4111-8111-111111111111';
  const files = [file('Notes/plain.md'), file('Notes/reminder.md', `- [ ] Due @2099-01-02T10:00:00.000Z <!-- crate-id:${id} -->`)];
  const result = await (await handleBatchUpload(request(files), env.BUCKET, env.DB, undefined, coordinatedNewFiles(env))).json() as BatchUploadResponse;
  expect(result.success).toBe(true);
  expect(await env.DB.prepare('SELECT id FROM staged_upload_batches').first()).toBeNull();
  expect(await env.DB.prepare("SELECT path FROM notification_projection_jobs WHERE path = 'Notes/plain.md'").first()).toBeNull();
  await drainNotificationProjections(env, 8);
  expect(await env.DB.prepare('SELECT reminder_id FROM reminder_projections').first()).toEqual({ reminder_id: id });
  for (const resultFile of result.results) expect(await env.BUCKET.head(resultFile.revision!)).not.toBeNull();
});
