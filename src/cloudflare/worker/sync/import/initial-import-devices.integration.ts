/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../../test-support/schema-test-harness';
import { SyncTestDevice } from '../../test-support/sync-engine-test-harness';
import { FIRST_UPLOAD_UNFINISHED } from '../../../../sync/engine/initial-import';
import { pendingChangeKey } from '../../../../sync/pending/pending-change';

const clients: SyncTestDevice[] = [];
beforeEach(async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  await applySchema(env.DB);
});
afterEach(async () => { for (const client of clients.splice(0)) client.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

async function device(id: string): Promise<SyncTestDevice> {
  const client = new SyncTestDevice(id, env); clients.push(client);
  await client.authorize(); await client.open();
  return client;
}

const serverPaths = async () => (await env.DB.prepare('SELECT path FROM files ORDER BY path').all<{ path: string }>()).results.map(row => row.path);

it('keeps the first device\'s unfinished import when a second device connects', async () => {
  const first = await device('first-import');
  await first.disk.vault.createFolder('Notes');
  first.disk.write('Notes/a.md', 'alpha'); first.disk.write('Notes/b.md', 'beta');
  vi.spyOn(first.api.initialImport, 'finish').mockRejectedValueOnce(new Error('offline'));
  expect(await first.engine.sync()).toMatchObject({ success: false, uploaded: 2, errors: ['offline'] });

  const second = await device('second-import');
  const joined = await second.engine.sync();
  expect(joined.success).toBe(false);
  expect(joined.errors).toEqual(['Another device is uploading this vault for the first time. Let it finish, then sync.']);
  expect(await serverPaths()).toEqual(['Notes/a.md', 'Notes/b.md']);

  first.close(); await first.open();
  expect((await first.engine.sync()).errors).toEqual([]);
  expect(first.disk.text('Notes/a.md')).toBe('alpha'); expect(first.disk.text('Notes/b.md')).toBe('beta');
  expect(first.disk.trash.size).toBe(0);
  expect(await serverPaths()).toEqual(['Notes/a.md', 'Notes/b.md']);

  expect((await second.engine.sync()).errors).toEqual([]);
  expect(second.disk.text('Notes/a.md')).toBe('alpha'); expect(second.disk.text('Notes/b.md')).toBe('beta');
});

it('resumes on the first device after its first upload response is lost', async () => {
  const first = await device('lost-receipt');
  first.disk.write('note.md', 'first');
  const paused = first.pauseNextUploadResponse();
  const interrupted = first.engine.sync();
  await paused.committed; first.close(); paused.release();
  expect((await interrupted).outcome).toBe('cancelled');
  expect(first.checkpoint().files['note.md']).toBeUndefined();

  const second = await device('lost-receipt-second');
  expect((await second.engine.sync()).errors).toEqual(['Another device is uploading this vault for the first time. Let it finish, then sync.']);
  await first.open();
  expect((await first.engine.sync()).errors).toEqual([]);
  expect(await serverPaths()).toEqual(['note.md']);
  expect(first.disk.text('note.md')).toBe('first');
});

it('holds another device\'s queued and selected uploads until the first upload finishes', async () => {
  const first = await device('import-owner');
  first.disk.write('a.md', 'alpha');
  vi.spyOn(first.api.initialImport, 'finish').mockRejectedValueOnce(new Error('offline'));
  expect((await first.engine.sync()).success).toBe(false);

  const second = await device('queued-uploader');
  second.settings.automaticSync = true; second.settings.debounceDelay = 0;
  second.disk.write('b.md', 'beta');
  second.engine.onFileChange(second.disk.vault.getAbstractFileByPath('b.md')!);
  await vi.waitFor(() => expect(second.engine.getState().lastError).toContain(FIRST_UPLOAD_UNFINISHED), { timeout: 10_000 });
  const selected = await second.engine.syncSelected([pendingChangeKey('upload', 'b.md')]);
  expect(selected.success).toBe(false);
  expect(selected.errors.join('\n')).toContain(FIRST_UPLOAD_UNFINISHED);
  expect(await serverPaths()).toEqual(['a.md']);

  // The owner's resumed upload would prune a file another device uploaded meanwhile.
  first.close(); await first.open();
  expect((await first.engine.sync()).errors).toEqual([]);
  second.settings.automaticSync = false;
  expect((await second.engine.sync()).errors).toEqual([]);
  expect(second.disk.text('b.md')).toBe('beta');
  expect(second.disk.trash.size).toBe(0);
  expect(await serverPaths()).toEqual(['a.md', 'b.md']);
});
