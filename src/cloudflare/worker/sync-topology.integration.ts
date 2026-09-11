/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { sha256Hex } from './auth';
import worker from './index';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '../../protocol';
import { SyncTestDevice } from './sync-engine-test-harness';
import { createReminderOperationId } from '../../protocol/reminder-operation';

const clients: SyncTestDevice[] = [];
beforeEach(async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope) VALUES ('audit', ?, 'vault')").bind(await sha256Hex('audit')).run();
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await reset();
});
async function request(path: string, body: unknown, token = 'audit') {
  return worker.fetch(new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
}

it('a remote folder-to-file replacement converges after its child is removed', async () => {
  const client = new SyncTestDevice('folder-receiver', env);
  clients.push(client);
  await client.authorize(); await client.open();
  await client.disk.vault.createFolder('Projects');
  client.disk.write('Projects/note.md', 'initial note');
  expect((await client.engine.sync()).success).toBe(true);
  const prior = (await client.api.getManifest()).files['Projects/note.md']!;
  expect((await request('/sync/delete', { path: 'Projects/note.md', expectedHash: prior.hash, expectedRevision: prior.revision })).status).toBe(200);
  const content = new TextEncoder().encode('replacement parent file');
  const upload = await worker.fetch(new Request('https://worker.test/sync/upload?path=Projects', {
    method: 'PUT', body: content,
    headers: { Authorization: 'Bearer audit', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current),
      'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86_400_000)) },
  }), env);
  expect(upload.status).toBe(200);
  let result = await client.engine.sync();
  for (let attempt = 0; attempt < 3 && !result.success; attempt++) result = await client.engine.sync();
  expect(result.success).toBe(true);
  expect(client.disk.has('Projects/note.md')).toBe(false);
  expect(client.disk.text('Projects')).toBe('replacement parent file');
  expect(await client.disk.vault.adapter.stat('Projects')).toMatchObject({ type: 'file' });
  expect((await client.api.getManifest()).files.Projects).toBeDefined();
});


it('a remote file-to-folder replacement converges without overwriting the original parent', async () => {
 const sender = new SyncTestDevice('topology-sender', env), receiver = new SyncTestDevice('topology-receiver', env);
 clients.push(sender, receiver);
 for (const device of [sender, receiver]) { await device.authorize(); await device.open(); }
 sender.disk.write('Projects', 'original parent'); expect((await sender.engine.sync()).success).toBe(true);
 expect((await receiver.engine.sync()).success).toBe(true);
 await sender.disk.vault.adapter.remove('Projects'); expect((await sender.engine.sync()).success).toBe(true);
 await sender.disk.vault.createFolder('Projects'); sender.disk.write('Projects/note.md', 'new child');
 const sent = await sender.engine.sync(); expect(sent.success, JSON.stringify(sent)).toBe(true);
 let result = await receiver.engine.sync();
 for (let attempt = 0; attempt < 3 && !result.success; attempt++) result = await receiver.engine.sync();
 expect(result.success).toBe(true); expect(receiver.disk.text('Projects/note.md')).toBe('new child');
 expect(await receiver.disk.vault.adapter.stat('Projects')).toMatchObject({type: 'folder'});
});
