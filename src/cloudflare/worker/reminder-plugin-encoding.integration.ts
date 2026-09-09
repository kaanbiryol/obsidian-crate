/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { TFile, type App } from 'obsidian';
import schema from '../schema.sql?raw';
import { SyncTestDevice } from './sync-engine-test-harness';
import { scanFile } from '../../reminders/data/vaultScanner';

const devices: SyncTestDevice[] = [];
const path = 'Reminders/Inbox.md';
const before = new TextEncoder().encode('Unrelated: caf');
const after = new TextEncoder().encode('\n\n- [ ] Task\n');
const original = new Uint8Array([...before, 0xe9, ...after]).buffer;
beforeEach(async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => {
  for (const device of devices.splice(0)) { device.close(); await device.engine.waitForIdle(); }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset();
});

async function prepare() {
  const a = new SyncTestDevice('byte-a', env), b = new SyncTestDevice('byte-b', env);
  devices.push(a, b);
  for (const device of devices) { await device.authorize(3_600_000); await device.open(); }
  await a.disk.vault.createFolder('Reminders');
  a.disk.write(path, original);
  return { a, b };
}
async function sync(device: SyncTestDevice) {
  const result = await device.engine.sync();
  expect(result.errors).toEqual([]);
  return result;
}

it('generic two-device sync conserves malformed UTF-8 bytes', async () => {
  const { a, b } = await prepare();
  await sync(a); await sync(b);
  expect(new Uint8Array(b.disk.read(path))).toEqual(new Uint8Array(original));
  expect(new Uint8Array((await a.api.downloadFile(path)).content)).toEqual(new Uint8Array(original));
});

it('adopting reminders before initial sync does not publish a lossy conversion to every replica', async () => {
  const { a, b } = await prepare();
  const app = { vault: { ...a.disk.vault, read: async (file: TFile) => a.disk.text(file.path) } } as unknown as App;
  const file = a.disk.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error('Expected the test note');
  const scanned = await scanFile(app, file, 'Reminders');
  expect(scanned.error).toContain('UTF-8');
  expect(scanned.reminders).toEqual([]);
  await sync(a); await sync(b);
  const remote = (await a.api.downloadFile(path)).content;
  const retained = await env.DB.prepare('SELECT COUNT(*) AS n FROM file_versions').first<{ n: number }>();
  expect(retained?.n).toBe(0);
  for (const copy of [a.disk.read(path), b.disk.read(path), remote]) {
    expect(new Uint8Array(copy)).toEqual(new Uint8Array(original));
  }
});
