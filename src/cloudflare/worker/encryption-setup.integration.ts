/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { SyncTestDevice } from './sync-engine-test-harness';
import { WorkerApiHttpClient } from '../../sync/worker-api/http';
import { convertEncryptedVault, type EncryptionFileProgress } from '../../sync/encryption-conversion';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode } from '../../encryption/key-bundle';
import { readEncryptionState } from './encryption-state';
import { FileKeyAuthority } from '../../encryption/file-authority';
import { openFile } from '../../encryption/file-codec';
import { SyncWorkerApi } from '../../sync/worker-api/sync';
import { computeHash } from '../../sync/hasher';

let device: SyncTestDevice;
beforeEach(async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  device = new SyncTestDevice('setup-device', env);
  device.settings.automaticSync = false;
  await device.authorize(3600_000); await device.open();
});
afterEach(async () => { device.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

async function fixture() {
  const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
  const recovery = await generateRecoveryCode();
  const requests: string[] = [], progress: EncryptionFileProgress[] = [];
  let interrupt = false;
  const http = new WorkerApiHttpClient(device.settings.workerUrl, device.id, async request => {
    const route = new URL(request.url);
    requests.push(`${request.method ?? 'GET'} ${route.pathname}${route.search}`);
    const response = await worker.fetch(new Request(request.url, { method: request.method, body: request.body,
      headers: { ...request.headers, ...(request.contentType ? { 'Content-Type': request.contentType } : {}) } }), env);
    const arrayBuffer = await response.arrayBuffer();
    if (interrupt && request.method === 'PUT' && route.pathname === '/encryption/conversion/file' && response.ok) {
      interrupt = false; throw new Error('Lost conversion response');
    }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), arrayBuffer, text: new TextDecoder().decode(arrayBuffer) };
  });
  return { bundle, requests, progress, interrupt: () => { interrupt = true; },
    convert: () => convertEncryptedVault(http, bundle, recovery, (_message, files) => { if (files) progress.push(files); }) };
}

it('activates an empty remote without uploading local files, then encrypts their first manual sync', async () => {
  device.disk.write('local.md', 'Never upload this as plaintext');
  const f = await fixture();
  await f.convert();
  expect((await readEncryptionState(env.DB))?.mode).toBe('active');
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM files').first<{ count: number }>()).toEqual({ count: 0 });
  expect(f.requests.some(route => route.includes('/conversion/file?'))).toBe(false);
  expect(device.requests.some(route => /upload/.test(route))).toBe(false);
  expect(device.settings.automaticSync).toBe(false);
  expect(device.disk.text('local.md')).toBe('Never upload this as plaintext');
  device.close(); await device.engine.waitForIdle(); await device.open();
  await device.api.configureEncryption(f.bundle);
  const result = await device.engine.sync();
  expect(result.errors).toEqual([]); expect(result.uploaded).toBe(1);
  const row = await env.DB.prepare("SELECT storage_key FROM files WHERE path='local.md'").first<{ storage_key: string }>();
  expect(await (await env.BUCKET.get(row!.storage_key))!.text()).not.toContain('Never upload this as plaintext');
});

it('converts existing files and retained history while unsynced local edits wait for encrypted sync', async () => {
  device.disk.write('note.md', 'Original server content');
  expect((await device.engine.sync()).success).toBe(true);
  device.disk.write('note.md', 'Current server content');
  expect((await device.engine.sync()).success).toBe(true);
  device.disk.write('note.md', 'Local change waiting for encryption');
  const f = await fixture();
  const existing = await env.DB.prepare('SELECT storage_key, path FROM files UNION SELECT storage_key, path FROM file_versions').all<{ storage_key: string; path: string }>();
  await f.convert();
  expect(f.progress[0]).toEqual({ completed: 0, total: existing.results.length });
  expect(f.progress.at(-1)).toEqual({ completed: existing.results.length, total: existing.results.length });
  expect(f.requests.filter(route => route.includes('includeProgress=1'))).toHaveLength(1);
  const keys = await FileKeyAuthority.fromVault(f.bundle);
  const contents: string[] = [];
  for (const row of existing.results) {
    const bytes = new Uint8Array(await (await env.BUCKET.get(row.storage_key))!.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).not.toContain('server content');
    contents.push(new TextDecoder().decode((await openFile(bytes, row.path, keys.forPath(row.path))).content));
  }
  expect(contents).toContain('Original server content'); expect(contents).toContain('Current server content');
  expect(contents).not.toContain('Local change waiting for encryption');
  expect(device.disk.text('note.md')).toBe('Local change waiting for encryption');
  device.close(); await device.engine.waitForIdle(); await device.open();
  await device.api.configureEncryption(f.bundle);
  const result = await device.engine.sync();
  expect(result.errors).toEqual([]); expect(result.uploaded).toBe(1);
  expect(new TextDecoder().decode((await device.api.downloadFile('note.md')).content)).toBe('Local change waiting for encryption');
});

it('counts only acknowledged replacements and resumes the remaining files after a lost reply', async () => {
  device.disk.write('one.md', 'One'); device.disk.write('two.md', 'Two');
  expect((await device.engine.sync()).success).toBe(true);
  const f = await fixture(); f.interrupt();
  await expect(f.convert()).rejects.toThrow('Lost conversion response');
  expect(f.progress.at(-1)).toEqual({ completed: 0, total: 2 });
  f.progress.length = 0;
  await f.convert();
  expect(f.progress[0]).toEqual({ completed: 0, total: 1 });
  expect(f.progress.at(-1)).toEqual({ completed: 1, total: 1 });
  expect((await readEncryptionState(env.DB))?.mode).toBe('active');
});

it.each([false, true])('recovers a pending plaintext upload after conversion without replaying plaintext (committed: %s)', async committed => {
  const content = new TextEncoder().encode('Pending local upload').buffer;
  device.disk.write('pending.md', content);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoke with the original receiver to simulate response loss after commitment.
  const original = SyncWorkerApi.prototype.uploadFile;
  vi.spyOn(SyncWorkerApi.prototype, 'uploadFile').mockImplementationOnce(async function (this: SyncWorkerApi, ...args) {
    if (committed) await original.apply(this, args);
    throw new Error('Connection lost');
  });
  await expect(device.files.uploadFile('pending.md', content, await computeHash(content), content.byteLength, 'text/markdown', null)).rejects.toThrow('Connection lost');
  const f = await fixture();
  await f.convert();
  device.close(); await device.engine.waitForIdle(); await device.open();
  await device.api.configureEncryption(f.bundle);
  const result = await device.engine.sync();
  expect(result.errors).toEqual([]); expect(result.uploaded).toBe(committed ? 0 : 1);
  expect(device.disk.text('pending.md')).toBe('Pending local upload');
  const row = await env.DB.prepare("SELECT storage_key FROM files WHERE path='pending.md'").first<{ storage_key: string }>();
  expect(await (await env.BUCKET.get(row!.storage_key))!.text()).not.toContain('Pending local upload');
});
