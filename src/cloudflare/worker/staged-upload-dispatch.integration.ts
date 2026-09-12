/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { writeCommittedMarkdownFile } from './storage';
import { getStoredFileRow, createManagedObjectKey } from './sync-storage';
import { trackStagedUpload } from './staged-uploads';
import { coordinatedUpload } from './staged-upload-dispatch';
import { sha256Hex } from './auth';

beforeEach(async () => {
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
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
  await trackStagedUpload(env.DB, objectKey);
  await env.BUCKET.put(objectKey, 'New');
  const result = await coordinatedUpload(env)(env.BUCKET, env.DB, {
    path, hash, size: 3, objectKey, content: 'New', expectedHash: first.hash, previousFile: staleSnapshot,
  });
  expect(result.committed).toBe(true);
  expect(await env.DB.prepare('SELECT storage_key FROM file_versions WHERE storage_key = ?').bind(current!.storageKey).first())
    .toEqual({ storage_key: current!.storageKey });
});
