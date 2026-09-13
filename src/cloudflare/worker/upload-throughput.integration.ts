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
const files = (extension = 'svg') => Array.from({ length: 4 }, (_, index) => ({
  path: `icons/${index}.${extension}`, content: btoa('original'), expectedHash: null as string | null,
  operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)),
}));
const send = (payload: ReturnType<typeof files>) => handleBatchUpload(new Request('https://test/sync/batch-upload', {
  method: 'POST', body: JSON.stringify({ files: payload }),
}), env.BUCKET, env.DB);

it('uses one lease write and commit-returned receipts for a larger asset batch', async () => {
  const payload = files();
  const prepare = vi.spyOn(env.DB, 'prepare');
  const put = vi.spyOn(env.BUCKET, 'put');
  const response = await send(payload);
  const receipts = await response.json() as BatchUploadResponse;
  expect(receipts.results).toHaveLength(4);
  expect(receipts.success).toBe(true);
  expect(prepare.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO staged_uploads'))).toHaveLength(1);
  expect(prepare.mock.calls.filter(([sql]) => sql.startsWith('SELECT request_hash, response_json') && !sql.includes('UNION ALL'))).toHaveLength(0);
  expect(put).toHaveBeenCalledTimes(4);
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(46); // Reserve queries for request authentication.
  const repeated = await (await send(payload)).json() as BatchUploadResponse;
  expect(repeated.results.sort((a, b) => a.path.localeCompare(b.path))).toEqual(receipts.results.sort((a, b) => a.path.localeCompare(b.path)));
  expect(put).toHaveBeenCalledTimes(4);
});

it('stays within the query budget on replacement and stale asset batches', async () => {
  const first = await (await send(files())).json() as BatchUploadResponse;
  const replacement = files().map(file => ({ ...file, content: btoa('new'), expectedHash: first.results.find(result => result.path === file.path)!.hash! }));
  const prepare = vi.spyOn(env.DB, 'prepare');
  expect((await (await send(replacement)).json() as BatchUploadResponse).success).toBe(true);
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(46);
  prepare.mockClear();
  const stale = await (await send(files())).json() as BatchUploadResponse;
  expect(stale.results.every(result => result.code === 'version_conflict')).toBe(true);
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(46);
});

it('rejects larger Markdown and mixed batches before storing objects', async () => {
  const put = vi.spyOn(env.BUCKET, 'put');
  expect((await send(files('MD'))).status).toBe(400);
  const mixed = files(); mixed[3]!.path = 'note.md';
  expect((await send(mixed)).status).toBe(400);
  expect(put).not.toHaveBeenCalled();
});

it('never sends objects if shared lease registration fails', async () => {
  const prepare = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB, 'prepare').mockImplementation(sql => {
    if (sql.startsWith('INSERT INTO staged_uploads')) throw new Error('Storage unavailable');
    return prepare(sql);
  });
  const put = vi.spyOn(env.BUCKET, 'put');
  expect((await send(files())).status).toBe(503);
  expect(put).not.toHaveBeenCalled();
});
