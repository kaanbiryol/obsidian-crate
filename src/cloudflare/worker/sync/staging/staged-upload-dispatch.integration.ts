/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../../test-support/schema-test-harness';
import { writeCommittedMarkdownFile } from '../../storage';
import { getStoredFileRow } from '../storage';
import { trackStagedUpload } from './staged-uploads';
import { coordinatedUpload } from './staged-upload-dispatch';
import { coordinatedNewFiles } from './bulk-upload-dispatch';
import { handleNotificationPolicy } from '../../notifications/policy';
import { handleBatchUpload } from '../batch/upload';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import type { BatchUploadResponse } from '@/protocol/sync-types';
import { createManagedObjectKey } from '@/protocol/storage-keys';
import { sha256Hex } from '@/platform/sha256';

beforeEach(async () => {
  await applySchema(env.DB);
});
afterEach(async () => { await reset(); });

it('retains the current revision when another same-content save finished during upload preparation', async () => {
  const path = 'Notes/Example.md';
  const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, 'Old', null);
  const staleSnapshot = await getStoredFileRow(env.DB, path);
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, 'Old', first.hash);
  const current = await getStoredFileRow(env.DB, path);
  expect(current!.storageKey).not.toBe(staleSnapshot!.storageKey);
  const hash = await sha256Hex('New');
  const objectKey = createManagedObjectKey(hash);
  await trackStagedUpload(env.DB, objectKey, path);
  await env.BUCKET.put(objectKey, 'New');
  const result = await coordinatedUpload(env)(env.BUCKET, env.DB, {
    path, hash, size: 3, objectKey, content: 'New', expectedHash: first.hash,
  });
  expect(result.committed).toBe(true);
  expect(await env.DB.prepare('SELECT storage_key FROM file_versions WHERE storage_key = ?').bind(current!.storageKey).first())
    .toEqual({ storage_key: current!.storageKey });
});

it.each(['single', 'batch'] as const)('commits a plaintext %s reminder upload without reading it back from R2', async kind => {
  await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({
    folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00',
  }) }), env.DB);
  const path = 'Reminders/Inbox.md';
  const content = `- [ ] Task 2099-01-01T12:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`;
  const get = env.BUCKET.get.bind(env.BUCKET);
  let reads = 0;
  env.BUCKET.get = ((...args: Parameters<R2Bucket['get']>) => { reads += 1; return get(...args); });
  try {
    if (kind === 'single') {
      const hash = await sha256Hex(content);
      const objectKey = createManagedObjectKey(hash);
      await trackStagedUpload(env.DB, objectKey, path);
      await env.BUCKET.put(objectKey, content);
      const size = new TextEncoder().encode(content).byteLength;
      expect((await coordinatedUpload(env)(env.BUCKET, env.DB, { path, hash, size, objectKey, content, expectedHash: null })).committed).toBe(true);
    } else {
      const response = await handleBatchUpload(new Request('https://test/sync/batch-upload', { method: 'POST', body: JSON.stringify({ bulkNewFiles: true, files: [
        { path, content: btoa(content), expectedHash: null, operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)) },
        { path: 'Notes/other.md', content: btoa('Other'), expectedHash: null, operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)) },
      ] }) }), env.BUCKET, env.DB, { commitUpload: coordinatedUpload(env), commitNewFiles: coordinatedNewFiles(env) });
      const body = await response.json() as BatchUploadResponse;
      expect(body.success, JSON.stringify(body)).toBe(true);
    }
  } finally { env.BUCKET.get = get; }
  expect(reads).toBe(0);
  expect(await env.DB.prepare('SELECT verified FROM reminder_source_state WHERE file_path = ?').bind(path).first()).toEqual({ verified: 1 });
  expect(await env.DB.prepare('SELECT path FROM notification_projection_jobs').first()).toEqual({ path });
});

it('reads the reminder policy and previous file once while committing a reminder upload', async () => {
  await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({
    folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00',
  }) }), env.DB);
  const path = 'Reminders/Inbox.md';
  const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, 'Old', null);
  const content = `- [ ] Task 2099-01-01T12:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`;
  const hash = await sha256Hex(content);
  const objectKey = createManagedObjectKey(hash);
  await trackStagedUpload(env.DB, objectKey, path);
  await env.BUCKET.put(objectKey, content);
  const prepare = env.DB.prepare.bind(env.DB);
  const reads: string[] = [];
  env.DB.prepare = (sql: string) => {
    if (/FROM notification_policy WHERE id = 1|notification_policy p ON p.id = 1|SELECT hash, size, storage_key FROM files/.test(sql)) reads.push(sql);
    return prepare(sql);
  };
  try {
    const size = new TextEncoder().encode(content).byteLength;
    expect((await coordinatedUpload(env)(env.BUCKET, env.DB, { path, hash, size, objectKey, content, expectedHash: first.hash })).committed).toBe(true);
  } finally { env.DB.prepare = prepare; }
  // Framed bytes need no policy read to prepare; one combined read commits the upload.
  expect(reads).toHaveLength(1);
  expect(await env.DB.prepare('SELECT storage_key FROM file_versions').all()).toMatchObject({ results: [{}] });
  expect(await env.DB.prepare('SELECT path FROM notification_projection_jobs').first()).toEqual({ path });
});
