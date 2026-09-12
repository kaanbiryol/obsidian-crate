/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { cleanStagedUploads } from './maintenance/staged-upload-cleanup';
import { trackStagedUpload } from './staged-uploads';
import { commitStagedFile } from './sync-mutations';
import { writeCommittedMarkdownFile } from './storage';
import { createManagedObjectKey, getStoredFileRow } from './sync-storage';
import { sha256Hex } from './auth';

beforeEach(async () => {
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
async function expiredObject(content = 'data') {
  const hash = await sha256Hex(content);
  const key = createManagedObjectKey(hash);
  await trackStagedUpload(env.DB, key);
  await env.BUCKET.put(key, content);
  await env.DB.prepare('UPDATE staged_uploads SET expires_at = 0 WHERE storage_key = ?').bind(key).run();
  return { key, hash };
}

it('removes staging records in the successful file transaction', async () => {
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Note.md', 'Hello', null);
  expect(await env.DB.prepare('SELECT * FROM staged_uploads').first()).toBeNull();
});
it('cleans an expired object and prevents its late publication', async () => {
  const { key, hash } = await expiredObject();
  expect(await cleanStagedUploads(env.BUCKET, env.DB)).toBe(1);
  expect(await env.BUCKET.head(key)).toBeNull();
  const result = await commitStagedFile(env.BUCKET, env.DB, {
    path: 'Late.bin', hash, size: 4, objectKey: key, content: 'data', expectedHash: null, previousFile: null,
  });
  expect(result.committed).toBe(false);
  expect(await getStoredFileRow(env.DB, 'Late.bin')).toBeNull();
});
it('keeps objects referenced by a live file or retained version', async () => {
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Note.md', 'Old', null);
  const previous = await getStoredFileRow(env.DB, 'Note.md');
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Note.md', 'New', previous!.hash);
  const current = await getStoredFileRow(env.DB, 'Note.md');
  for (const key of [previous!.storageKey, current!.storageKey]) await trackStagedUpload(env.DB, key);
  await env.DB.prepare('UPDATE staged_uploads SET expires_at = 0').run();
  expect(await cleanStagedUploads(env.BUCKET, env.DB)).toBe(2);
  expect(await env.BUCKET.head(previous!.storageKey)).not.toBeNull();
  expect(await env.BUCKET.head(current!.storageKey)).not.toBeNull();
});
it('retains a missing-object record and later cleans a late upload', async () => {
  const key = createManagedObjectKey(await sha256Hex('late'));
  await trackStagedUpload(env.DB, key);
  await env.DB.prepare('UPDATE staged_uploads SET expires_at = 0').run();
  expect(await cleanStagedUploads(env.BUCKET, env.DB)).toBe(0);
  expect(await env.DB.prepare('SELECT state, attempts FROM staged_uploads').first()).toEqual({ state: 'deleting', attempts: 1 });
  await env.BUCKET.put(key, 'late');
  await env.DB.prepare('UPDATE staged_uploads SET expires_at = 0').run();
  expect(await cleanStagedUploads(env.BUCKET, env.DB)).toBe(1);
  expect(await env.BUCKET.head(key)).toBeNull();
});
it('pauses after eight inconclusive cleanup attempts and keeps the record', async () => {
  await trackStagedUpload(env.DB, createManagedObjectKey('missing'));
  for (let i = 0; i < 8; i++) {
    await env.DB.prepare('UPDATE staged_uploads SET expires_at = 0 WHERE expires_at IS NOT NULL').run();
    await cleanStagedUploads(env.BUCKET, env.DB);
  }
  expect(await env.DB.prepare('SELECT attempts, expires_at FROM staged_uploads').first()).toEqual({ attempts: 8, expires_at: null });
  expect(await cleanStagedUploads(env.BUCKET, env.DB)).toBe(0);
});
it('does not reclaim a successful commit whose response was lost', async () => {
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => {
    await batch(statements); throw new Error('Response lost');
  });
  await expect(writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Note.md', 'Hello', null)).rejects.toThrow('Response lost');
  const current = await getStoredFileRow(env.DB, 'Note.md');
  expect(current).not.toBeNull();
  expect(await cleanStagedUploads(env.BUCKET, env.DB)).toBe(0);
  expect(await env.BUCKET.head(current!.storageKey)).not.toBeNull();
});
