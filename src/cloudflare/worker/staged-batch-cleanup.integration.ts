/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { trackStagedBatch } from './staged-upload-batches';
import { cleanStagedBatches } from './maintenance/staged-batch-cleanup';
import { commitNewFiles } from './bulk-new-file-commit';
import { handleBatchUpload } from './sync-batch/upload';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { runMaintenanceEpisode } from './maintenance/lifecycle';
import { handleDiagnostics } from './maintenance/diagnostics';

beforeEach(async () => {
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

const expire = () => env.DB.prepare('UPDATE staged_upload_batches SET expires_at = 0 WHERE expires_at IS NOT NULL').run();
async function batch(keys: string[]) {
  const id = await trackStagedBatch(env.DB, keys);
  await Promise.all(keys.map(key => env.BUCKET.put(key, 'content')));
  return id!;
}
const request = () => new Request('https://test/sync/batch-upload', { method: 'POST', body: JSON.stringify({
  bulkNewFiles: true, files: Array.from({ length: 8 }, (_, i) => ({ path: `${i}.md`, content: btoa('note'), expectedHash: null,
    operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)) })),
}) });

it('registers one lease before any R2 puts and retires it with the successful commit', async () => {
  const put = env.BUCKET.put.bind(env.BUCKET);
  const counts: number[] = [];
  vi.spyOn(env.BUCKET, 'put').mockImplementation(async (...args) => {
    counts.push((await env.DB.prepare('SELECT COUNT(*) AS n FROM staged_upload_batches').first<{ n: number }>())!.n);
    return put(...args);
  });
  expect((await handleBatchUpload(request(), env.BUCKET, env.DB)).status).toBe(200);
  expect(counts).toEqual(Array(8).fill(1));
  expect(await env.DB.prepare('SELECT id FROM staged_upload_batches').first()).toBeNull();
  expect(await env.DB.prepare('SELECT storage_key FROM staged_uploads').first()).toBeNull();
});

it('does not upload any objects when batch registration fails', async () => {
  const prepare = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB, 'prepare').mockImplementation(sql => {
    if (sql.startsWith('INSERT INTO staged_upload_batches')) throw new Error('Database unavailable');
    return prepare(sql);
  });
  const put = vi.spyOn(env.BUCKET, 'put');
  expect((await handleBatchUpload(request(), env.BUCKET, env.DB)).status).toBe(503);
  expect(put).not.toHaveBeenCalled();
});

it('cleans expired keys and prevents a delayed bulk commit from publishing them', async () => {
  const response = await handleBatchUpload(request(), env.BUCKET, env.DB, undefined, async (bucket, db, files) => {
    await expire();
    expect(await cleanStagedBatches(bucket, db)).toBe(8);
    return commitNewFiles(bucket, db, files);
  });
  const result = await response.json() as { results: Array<{ success: boolean }> };
  expect(result.results).toHaveLength(8);
  expect(result.results.every(file => !file.success)).toBe(true);
  expect(await env.DB.prepare('SELECT path FROM files').first()).toBeNull();
});

it('retains missing keys to collect a late R2 upload without risking committed files', async () => {
  await handleBatchUpload(request(), env.BUCKET, env.DB);
  const live = await env.DB.prepare('SELECT storage_key FROM files LIMIT 1').first<{ storage_key: string }>();
  const id = await trackStagedBatch(env.DB, [live!.storage_key, 'late-key']);
  await expire();
  expect(await cleanStagedBatches(env.BUCKET, env.DB)).toBe(1);
  expect(await env.DB.prepare('SELECT storage_keys, state FROM staged_upload_batches WHERE id = ?').bind(id).first())
    .toEqual({ storage_keys: '[{"storageKey":"late-key"}]', state: 'deleting' });
  expect(await env.BUCKET.head(live!.storage_key)).not.toBeNull();
  await env.BUCKET.put('late-key', 'late bytes');
  await expire();
  expect(await cleanStagedBatches(env.BUCKET, env.DB)).toBe(1);
  expect(await env.BUCKET.head('late-key')).toBeNull();
  expect(await env.DB.prepare('SELECT id FROM staged_upload_batches').first()).toBeNull();
});

it('retries a failed R2 delete and bounds work to two batches per pass', async () => {
  for (let i = 0; i < 3; i++) await batch([`key-${i}`]);
  await expire();
  vi.spyOn(env.BUCKET, 'delete').mockRejectedValueOnce(new Error('Unavailable'));
  expect(await cleanStagedBatches(env.BUCKET, env.DB)).toBe(1);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM staged_upload_batches').first()).toEqual({ n: 2 });
  await expire();
  expect(await cleanStagedBatches(env.BUCKET, env.DB)).toBe(2);
  expect(await env.DB.prepare('SELECT id FROM staged_upload_batches').first()).toBeNull();
});

it('pauses missing keys after eight attempts and includes them in diagnostics', async () => {
  await trackStagedBatch(env.DB, ['missing-key']);
  for (let i = 0; i < 8; i++) { await expire(); await cleanStagedBatches(env.BUCKET, env.DB); }
  expect(await env.DB.prepare('SELECT attempts, expires_at FROM staged_upload_batches').first())
    .toEqual({ attempts: 8, expires_at: null });
  const diagnostics = await (await handleDiagnostics(env.DB)).json() as { pausedUploadCleanup: Array<{ storageKey: string }> };
  expect(diagnostics.pausedUploadCleanup[0]?.storageKey).toBe('missing-key');
});

it('schedules maintenance at the next batch expiration', async () => {
  const id = await batch(['waiting']);
  await env.DB.prepare("INSERT INTO maintenance_state(key, value) VALUES ('legacy_orphan_sweep_done', '1')").run();
  const lease = await env.DB.prepare('SELECT expires_at FROM staged_upload_batches WHERE id = ?').bind(id).first<{ expires_at: number }>();
  const setAlarm = vi.fn();
  await runMaintenanceEpisode({ storage: { get: async () => 0, put: async () => {}, setAlarm } } as never, env);
  expect(setAlarm).toHaveBeenCalledWith(lease!.expires_at);
});
