/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { handleBatchUpload } from './sync-batch/upload';
import type { BatchUploadResponse } from '@/protocol/sync-types';

beforeEach(async () => {
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const file = (path: string, content = '# Ordinary note') => ({ path, content: btoa(content), expectedHash: null as string | null,
  operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)) });
const send = (files: ReturnType<typeof file>[], bulkNewFiles = true) => handleBatchUpload(new Request('https://test/sync/batch-upload', {
  method: 'POST', body: JSON.stringify({ files, bulkNewFiles }),
}), env.BUCKET, env.DB);
const body = async (files: ReturnType<typeof file>[], bulk = true) => (await send(files, bulk)).json() as Promise<BatchUploadResponse>;

it('commits eight notes with grouped projection writes and one transaction', async () => {
  const files = Array.from({ length: 8 }, (_, i) => file(`${i}.md`));
  const batch = vi.spyOn(env.DB, 'batch'); const prepare = vi.spyOn(env.DB, 'prepare');
  const response = await body(files);
  expect(response.success, JSON.stringify(response)).toBe(true);
  expect(response.results).toHaveLength(8);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(46);
  expect((await env.DB.prepare('SELECT * FROM reminder_source_state WHERE verified = 1').all()).results).toHaveLength(8);
  expect((await env.DB.prepare('SELECT * FROM changelog').all()).results).toHaveLength(8);
  const repeat = await body(files);
  expect(repeat.results.sort((a,b) => a.path.localeCompare(b.path))).toEqual(response.results.sort((a,b) => a.path.localeCompare(b.path)));
  expect(batch).toHaveBeenCalledTimes(1);
});
it('preserves committed bytes and receipts after losing the transaction response', async () => {
  const files = Array.from({ length: 8 }, (_, i) => file(`${i}.md`));
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => { await batch(statements); throw new Error('Response lost'); });
  expect((await send(files)).status).toBe(503);
  const put = vi.spyOn(env.BUCKET, 'put');
  expect((await body(files)).success).toBe(true);
  expect(put).not.toHaveBeenCalled();
  const rows = await env.DB.prepare('SELECT storage_key FROM files').all<{ storage_key: string }>();
  for (const row of rows.results) expect(await env.BUCKET.get(row.storage_key)).not.toBeNull();
});
it('does not overwrite an existing file and keeps a rejected receipt stable', async () => {
  const original = file('existing.md', 'original');
  expect((await body([original], false)).success).toBe(true);
  const files = [file('existing.md', 'overwrite'), ...Array.from({ length: 7 }, (_, i) => file(`${i}.md`))];
  const prepare = vi.spyOn(env.DB, 'prepare');
  const result = await body(files);
  expect(result.results.find(row => row.path === 'existing.md')?.code).toBe('version_conflict');
  expect(result.results.filter(row => row.success)).toHaveLength(7);
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(46);
  expect((await body(files)).results).toEqual(result.results);
});
it('serializes namespace conflicts within the same bulk transaction', async () => {
  const result = await body([file('Folder'), file('folder/child.md')]);
  expect(result.results.filter(row => row.success)).toHaveLength(1);
  expect(result.results.filter(row => row.code === 'namespace_conflict')).toHaveLength(1);
});
it('rejects duplicate identities and non-absent preconditions before writing', async () => {
  const a = file('a.md'); const b = { ...file('b.md'), operationId: a.operationId };
  const put = vi.spyOn(env.BUCKET, 'put');
  expect((await send([a,b])).status).toBe(400);
  expect((await send([{ ...a, expectedHash: 'a'.repeat(64) }])).status).toBe(400);
  expect(put).not.toHaveBeenCalled();
});
it('records reminder ownership and quarantines malformed notes in the bulk transaction', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const valid = `- [ ] Due @2099-01-02T10:00:00.000Z <!-- crate-id:${id} -->`;
  const result = await body([file('a.md', valid), file('b.md', valid), file('bad.md', valid + '\n<!-- crate-desc:v1:%invalid -->')]);
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect((await env.DB.prepare('SELECT * FROM reminder_sources').all()).results).toHaveLength(2);
  expect(await env.DB.prepare("SELECT verified FROM reminder_source_state WHERE file_path = 'bad.md'").first()).toEqual({ verified: 0 });
  expect(await env.DB.prepare("SELECT available_at FROM notification_file_retries WHERE path = 'bad.md'").first()).toEqual({ available_at: -1 });
});
it('replays original receipts after deletion without resurrecting files', async () => {
  const files = [file('gone.md')];
  const original = await body(files);
  await env.DB.prepare("DELETE FROM files WHERE path = 'gone.md'").run();
  expect(await body(files)).toEqual(original);
  expect(await env.DB.prepare("SELECT path FROM files WHERE path = 'gone.md'").first()).toBeNull();
});
it('recovers the missing member after an interrupted object upload', async () => {
  const files = Array.from({ length: 8 }, (_, i) => file(`${i}.md`));
  const put = vi.spyOn(env.BUCKET, 'put').mockRejectedValueOnce(new Error('Connection lost'));
  const first = await body(files);
  expect(first.results.filter(row => row.success)).toHaveLength(7);
  put.mockClear();
  expect((await body(files)).success).toBe(true);
  expect(put).toHaveBeenCalledTimes(1);
  expect((await env.DB.prepare('SELECT * FROM changelog').all()).results).toHaveLength(8);
});
it('commits each logical file once across simultaneous bulk retries', async () => {
  const files = Array.from({ length: 8 }, (_, i) => file(`${i}.md`));
  const [a, b] = await Promise.all([body(files), body(files)]);
  const sort = (result: BatchUploadResponse) => result.results.sort((x,y) => x.path.localeCompare(y.path));
  expect(a.success).toBe(true); expect(b.success).toBe(true);
  expect(sort(a)).toEqual(sort(b));
  expect((await env.DB.prepare('SELECT * FROM changelog').all()).results).toHaveLength(8);
});
it('publishes no file if the transaction fails before commit, then retries safely', async () => {
  const files = Array.from({ length: 8 }, (_, i) => file(`${i}.md`));
  vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('Database unavailable'));
  expect((await send(files)).status).toBe(503);
  expect(await env.DB.prepare('SELECT path FROM files').first()).toBeNull();
  expect((await body(files)).success).toBe(true);
});
