/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { beginInitialImport, finishInitialImport } from './initial-import';
import { uploadInitialFiles } from './initial-import-upload';
import { pruneInitialImport } from './initial-import-prune';
import { sha256Hex } from './auth';
import { importInventoryHash, INITIAL_IMPORT_MAX_FILES } from '@/protocol/initial-import';
import { meterD1Writes } from './d1-write-meter-test-harness';
import { handleGetChanges, handleGetManifest } from './sync-metadata-handlers';
import { revalidateReminderSources } from './reminder-source-migration';
import { drainNotificationProjections } from './notification-projection';
import { handleNotificationPolicy } from './notification-policy';
import { SyncTestDevice } from './sync-engine-test-harness';
import type { BatchUploadResponse } from '@/protocol/sync-types';

const clients: SyncTestDevice[] = [];
beforeEach(async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { for (const client of clients.splice(0)) client.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });
const jsonRequest = (value: unknown) => new Request('https://test', { method: 'POST', body: JSON.stringify(value) });
async function start(db = env.DB): Promise<string> { return ((await (await beginInitialImport(db)).json()) as { import: { token: string } }).import.token; }
async function file(path: string, content = '# Note', expectedHash: string | null = null) {
  return { path, hash: await sha256Hex(content), content: btoa(content), expectedHash };
}
async function send(token: string, files: Awaited<ReturnType<typeof file>>[], db = env.DB) {
  return (await uploadInitialFiles(new Request('https://test', { method: 'POST', headers: { 'X-Crate-Import': token }, body: JSON.stringify({ files }) }), env.BUCKET, db)).json() as Promise<BatchUploadResponse>;
}
async function finish(token: string, db = env.DB) {
  const rows = await env.DB.prepare('SELECT path, hash, size FROM files').all<{ path: string; hash: string; size: number }>();
  return finishInitialImport(jsonRequest({ token, inventoryHash: await importInventoryHash(Object.fromEntries(rows.results.map(row => [row.path, row]))) }), db);
}

it('uses committed metadata to resume after a lost transaction response without writing receipts or reuploading bytes', async () => {
  const token = await start(); const files = await Promise.all(Array.from({ length: 8 }, (_, i) => file(`Notes/${i}.md`)));
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => { await batch(statements); throw new Error('response lost'); });
  await expect(send(token, files)).rejects.toThrow('response lost');
  const put = vi.spyOn(env.BUCKET, 'put'); const meter = meterD1Writes(env.DB);
  expect((await send(token, files, meter.db)).success).toBe(true);
  expect(put).not.toHaveBeenCalled(); expect(meter.writes()).toBe(0);
  for (const table of ['changelog', 'file_versions', 'upload_operations', 'reminder_source_state', 'notification_projection_jobs']) {
    expect(await env.DB.prepare(`SELECT 1 FROM ${table} LIMIT 1`).first()).toBeNull();
  }
  expect(await start()).toBe(token);
});

it('resumes only missing files after a partial upload and keeps confirmed files across long pauses', async () => {
  const token = await start(); const files = await Promise.all(Array.from({ length: 8 }, (_, i) => file(`Notes/${i}.md`)));
  const put = vi.spyOn(env.BUCKET, 'put').mockRejectedValueOnce(new Error('offline'));
  expect((await send(token, files)).results.filter(row => row.success)).toHaveLength(7);
  put.mockClear(); expect((await send(token, files)).success).toBe(true); expect(put).toHaveBeenCalledTimes(1);
});

it('replaces changes and removes local deletions during a paused import without version history', async () => {
  const token = await start(); const before = await file('note.md');
  await send(token, [before, await file('removed.md')]);
  expect((await send(token, [await file('note.md', 'Changed', before.hash)])).success).toBe(true);
  const removed = await file('removed.md');
  expect((await pruneInitialImport(jsonRequest({ token, files: [removed] }), env.DB)).status).toBe(200);
  expect(await env.DB.prepare('SELECT 1 FROM file_versions').first()).toBeNull();
  expect(await env.DB.prepare('SELECT 1 FROM changelog').first()).toBeNull();
  expect(await env.DB.prepare("SELECT path FROM files WHERE path = 'removed.md'").first()).toBeNull();
  expect((await finish(token)).status).toBe(200);
});

it('publishes one baseline, rejects incomplete completion, and fences closed import requests', async () => {
  const token = await start(); await send(token, [await file('note.md')]);
  expect((await finishInitialImport(jsonRequest({ token, inventoryHash: 'wrong' }), env.DB)).status).toBe(409);
  expect((await finish(token)).status).toBe(200);
  const manifest = await (await handleGetManifest(new Request('https://test'), env.DB)).json() as { lastSeq: number };
  expect(manifest.lastSeq).toBe(1);
  expect(await (await handleGetChanges(new Request('https://test?since=0'), env.DB)).json()).toMatchObject({ cursorExpired: true, lastSeq: 1 });
  expect(await (await handleGetChanges(new Request('https://test?since=1'), env.DB)).json()).toMatchObject({ changes: [], lastSeq: 1 });
  await env.DB.prepare("DELETE FROM files WHERE path = 'note.md'").run();
  expect(await send(token, [await file('note.md')])).toMatchObject({ error: 'Initial import is closed or unavailable' });
  expect(await (await beginInitialImport(env.DB)).json()).toEqual({ import: null });
  await env.DB.prepare("INSERT INTO changelog(path, action) VALUES ('next.md', 'put')").run();
  expect(await env.DB.prepare('SELECT seq FROM changelog').first()).toEqual({ seq: 2 });
});

it('does not enter import mode for an existing or previously emptied vault', async () => {
  await env.DB.prepare("INSERT INTO changelog(path, action) VALUES ('old.md', 'delete')").run();
  expect(await (await beginInitialImport(env.DB)).json()).toEqual({ import: null });
});

it('scans only the selected folder after import, and changing folders never parses old or unrelated notes', async () => {
  await handleNotificationPolicy(jsonRequest({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: null }), env.DB);
  await revalidateReminderSources(env, 4);
  expect(await env.DB.prepare("SELECT value FROM maintenance_state WHERE key = 'reminder_source_scan_portable_v9:Reminders'").first()).toEqual({ value: '' });
  const token = await start(); const id = '11111111-1111-4111-8111-111111111111';
  const content = `- [ ] Due @2099-01-02T10:00:00.000Z <!-- crate-id:${id} -->`;
  await send(token, [await file('Reminders/work.md', content), await file('Notes/unrelated.md', content), await file('Reminders-old/no.md', content), await file('Tasks/work.md', content)]);
  const get = vi.spyOn(env.BUCKET, 'get');
  await revalidateReminderSources(env, 4); expect(get).not.toHaveBeenCalled();
  await finish(token); await revalidateReminderSources(env, 4); await drainNotificationProjections(env, 8);
  expect((await env.DB.prepare('SELECT file_path FROM reminder_source_state').all()).results).toEqual([{ file_path: 'Reminders/work.md' }]);
  const policy = await env.DB.prepare('SELECT revision FROM notification_policy').first<{ revision: string }>();
  await handleNotificationPolicy(new Request('https://test', { method: 'PUT', body: JSON.stringify({ folderPath: 'Tasks', timezone: 'UTC', allDayTime: null, expectedRevision: policy!.revision }) }), env.DB);
  get.mockClear(); await revalidateReminderSources(env, 4); await drainNotificationProjections(env, 8);
  const current = await env.DB.prepare("SELECT storage_key FROM files WHERE path = 'Tasks/work.md'").first<{ storage_key: string }>();
  expect(get.mock.calls.every(([key]) => key === current!.storage_key)).toBe(true);
  expect((await env.DB.prepare('SELECT file_path FROM reminder_source_state').all()).results).toEqual([{ file_path: 'Tasks/work.md' }]);
});

it('finishes on the first device, then downloads the vault onto a new device', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const first = new SyncTestDevice('first-import', env); clients.push(first); await first.authorize(); await first.open();
  await first.disk.vault.createFolder('Notes'); await first.disk.vault.createFolder('Assets');
  first.disk.write('Notes/note.md', 'My note'); first.disk.write('Assets/data.bin', 'data');
  const put = vi.spyOn(env.BUCKET, 'put');
  expect((await first.engine.initialSync()).errors).toEqual([]);
  expect(first.requests).toContain('POST /sync/import/upload');
  expect(await env.DB.prepare('SELECT 1 FROM upload_operations').first()).toBeNull();
  const second = new SyncTestDevice('second-import', env); clients.push(second); await second.authorize(); await second.open();
  put.mockClear(); expect((await second.engine.sync()).errors).toEqual([]);
  expect(second.disk.text('Notes/note.md')).toBe('My note'); expect(second.disk.text('Assets/data.bin')).toBe('data');
  expect(put).not.toHaveBeenCalled();
});

it('fences an upload that finishes staging after the initial snapshot is complete', async () => {
  const token = await start();
  await send(token, [await file('committed.md')]);
  const put = env.BUCKET.put.bind(env.BUCKET);
  vi.spyOn(env.BUCKET, 'put').mockImplementationOnce(async (...args) => {
    expect((await finish(token)).status).toBe(200);
    return put(...args);
  });
  expect((await send(token, [await file('late.md')])).success).toBe(false);
  expect(await env.DB.prepare("SELECT path FROM files WHERE path = 'late.md'").first()).toBeNull();
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM object_cleanup_queue').first()).toEqual({ n: 1 });
});

it('rechecks completion when a batch commits during inventory verification', async () => {
  const token = await start();
  await send(token, [await file('first.md')]);
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => {
    await send(token, [await file('second.md')]);
    return batch(statements);
  });
  expect((await finish(token)).status).toBe(409);
  expect(await env.DB.prepare('SELECT state FROM initial_import').first()).toEqual({ state: 'importing' });
  expect((await finish(token)).status).toBe(200);
});

it('resumes changed attachments in larger batches and sends large files as binary', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const client = new SyncTestDevice('attachment-import', env); clients.push(client);
  await client.authorize(); await client.open();
  for (let index = 0; index < 17; index++) client.disk.write(`asset-${index}.bin`, 'original');
  client.disk.write('large.bin', 'x'.repeat(1024 * 1024));
  vi.spyOn(client.api.initialImport, 'finish').mockRejectedValueOnce(new Error('Connection lost before completion'));
  const interrupted = await client.engine.initialSync();
  expect(interrupted.success).toBe(false);
  expect(interrupted.uploaded).toBe(18);
  expect(interrupted.uploadedPaths).toHaveLength(18);
  expect(client.requests).toContain('PUT /sync/import/upload');
  client.close(); await client.open();
  for (let index = 0; index < 17; index++) client.disk.write(`asset-${index}.bin`, 'changed');
  const upload = vi.spyOn(client.api.initialImport, 'upload');
  const result = await client.engine.sync();
  expect(result.errors).toEqual([]); expect(result.uploaded).toBe(17);
  expect(upload.mock.calls.map(([, files]) => files.length)).toEqual([17]);
  expect(await env.DB.prepare('SELECT 1 FROM file_versions').first()).toBeNull();
});

it('preserves confirmed uploads when a resumed standard sync fails', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const client = new SyncTestDevice('resumed-result', env); clients.push(client);
  await client.authorize(); await client.open(); client.disk.write('note.md', 'Note');
  vi.spyOn(client.api.initialImport, 'finish').mockRejectedValueOnce(new Error('offline'));
  const interrupted = await client.engine.sync();
  expect(interrupted).toMatchObject({ success: false, uploaded: 1, uploadedPaths: ['note.md'], errors: ['offline'] });
  expect(client.engine.getTimings().requests?.d1).toMatchObject({ rowsWritten: 7 });
  client.close(); await client.open();
  expect(await client.engine.sync()).toMatchObject({ success: true, uploaded: 0 });
});

it('recovers a lost completion response after restarting without uploading committed files again', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const client = new SyncTestDevice('completion-import', env); clients.push(client);
  await client.authorize(); await client.open(); client.disk.write('note.md', 'complete');
  const finish = client.api.initialImport.finish.bind(client.api.initialImport);
  vi.spyOn(client.api.initialImport, 'finish').mockImplementationOnce(async (...args) => {
    await finish(...args); throw new Error('Completion response lost');
  });
  expect((await client.engine.initialSync()).success).toBe(false);
  client.close(); await client.open();
  const put = vi.spyOn(env.BUCKET, 'put');
  expect((await client.engine.sync()).errors).toEqual([]);
  expect(put).not.toHaveBeenCalled();
  expect(client.settings.lastSeq).toBe(1);
});

it('keeps full import requests under the free D1 query limit, including rejected members', async () => {
  const client = new SyncTestDevice('import-query-budget', env); clients.push(client);
  await client.authorize(); await client.open();
  const session = await client.api.initialImport.begin();
  const content = new TextEncoder().encode('original').buffer;
  const files = Array.from({ length: INITIAL_IMPORT_MAX_FILES }, (_, i) => ({
    path: `note-${i}.md`, content, size: content.byteLength, hash: '', expectedHash: null,
  }));
  const hash = await sha256Hex('original');
  for (const file of files) file.hash = hash;
  const prepare = vi.spyOn(env.DB, 'prepare');
  expect((await client.api.initialImport.upload(session!.token, files)).success).toBe(true);
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(45);
  const changed = new TextEncoder().encode('changed').buffer;
  const changedHash = await sha256Hex('changed');
  prepare.mockClear();
  const rejected = await client.api.initialImport.upload(session!.token, files.map(file => ({
    ...file, content: changed, size: changed.byteLength, hash: changedHash,
  })));
  expect(rejected.results).toHaveLength(INITIAL_IMPORT_MAX_FILES);
  expect(rejected.results.every(result => result.code === 'version_conflict')).toBe(true);
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(45);
});

it('splits larger import batches at the existing byte limit', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const client = new SyncTestDevice('import-byte-budget', env); clients.push(client);
  await client.authorize(); await client.open();
  for (let index = 0; index < 12; index++) client.disk.write(`asset-${index}.bin`, 'x'.repeat(900 * 1024));
  const upload = vi.spyOn(client.api.initialImport, 'upload');
  expect((await client.engine.initialSync()).errors).toEqual([]);
  expect(upload.mock.calls.map(([, files]) => files.length)).toEqual([11, 1]);
});

it.each([8, INITIAL_IMPORT_MAX_FILES])('measures 10,000-note import writes with %i-file batches including setup and completion', async batchSize => {
  const meter = meterD1Writes(env.DB); const token = await start(meter.db);
  const hash = await sha256Hex('# Note');
  for (let offset = 0; offset < 10000; offset += batchSize) {
    const files = Array.from({ length: Math.min(batchSize, 10000 - offset) }, (_, i) => ({ path: `Notes/${offset + i}.md`, hash, content: btoa('# Note'), expectedHash: null }));
    expect((await send(token, files, meter.db)).success).toBe(true);
  }
  expect((await finish(token, meter.db)).status).toBe(200);
  await revalidateReminderSources({ ...env, DB: meter.db }, 4);
  expect(meter.writes()).toBeLessThan(16000);
  expect(meter.writes()).toBe(batchSize === 8 ? 15004 : 11256);
  console.info('Initial import D1 writes:', meter.writes());
}, 120000);
