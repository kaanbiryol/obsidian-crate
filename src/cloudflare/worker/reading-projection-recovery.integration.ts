/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from './storage';
import { createReadingNote } from '@/reading/core/notes';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { projectReading } from './reading/projection';
import { handleReadingRoute } from './reading/routes';
import { getStoredFileRow } from './sync-storage';
import { runNotificationCoordinator } from './notification-coordinator';

const policy = { enabled: 0, folder_path: 'Reading', generation: 'g', revision: 'r' };
const principal = { tokenId: 'vault', scope: 'vault' as const };
const url = 'https://example.invalid/read';
const path = 'Reading/Note.md';
const list = () => handleReadingRoute(new Request('https://test/reading/list'), env, principal);
const capture = () => handleReadingRoute(new Request('https://test/reading/capture', { method: 'POST', body: JSON.stringify({
  url, fetchArticle: false, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)),
}) }), env, principal);
async function seed(target = path) {
  const id = crypto.randomUUID();
  const note = createReadingNote({ id, url, savedAt: new Date().toISOString() });
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, target, note, null);
  return { id, note, file: (await getStoredFileRow(env.DB, target))! };
}
beforeEach(async () => {
  await env.DB.batch(schema.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => env.DB.prepare(sql)));
  await env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,0,'Reading','g','r')").run();
  await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
});
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await reset(); });

it('schedules outage recovery with a delay and stops after a healthy projection', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
  await seed();
  const setAlarm = vi.fn();
  const state = { storage: { setAlarm } } as unknown as DurableObjectState;
  const read = vi.spyOn(env.BUCKET, 'get').mockRejectedValue(new Error('temporary R2 outage'));
  await runNotificationCoordinator(state, env);
  expect(setAlarm).toHaveBeenCalledExactlyOnceWith(Date.now() + 30_000);
  read.mockRestore(); setAlarm.mockClear();
  await runNotificationCoordinator(state, env);
  expect(setAlarm).not.toHaveBeenCalled();
});

it('keeps a transient R2 failure retryable and blocks duplicate capture until recovery', async () => {
  const { id, file } = await seed();
  const read = vi.spyOn(env.BUCKET, 'get').mockRejectedValue(new Error('temporary R2 outage'));
  expect((await list()).status).toBe(503);
  expect((await capture()).status).toBe(503);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM files').first()).toMatchObject({ n: 1 });
  expect(await env.DB.prepare('SELECT * FROM reading_sources').first()).toBeNull();
  expect(await env.DB.prepare('SELECT * FROM reading_operations').first()).toBeNull();
  read.mockRestore();
  const response = await list();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ items: [{ crate_reading_id: id }], issues: [] });
  expect(await (await capture()).json()).toMatchObject({ alreadySaved: true, id });
  expect((await getStoredFileRow(env.DB, path))?.storageKey).toBe(file.storageKey);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM files').first()).toMatchObject({ n: 1 });
});

it.each(['missing', 'wrong size', 'wrong hash'])('recovers from %s source bytes without editing the file revision', async failure => {
  const { id, note, file } = await seed();
  if (failure === 'missing') await env.BUCKET.delete(file.storageKey);
  else await env.BUCKET.put(file.storageKey, failure === 'wrong size' ? 'bad' : 'x'.repeat(new TextEncoder().encode(note).byteLength));
  expect(await projectReading(env, policy)).toBe('unavailable');
  expect(await env.DB.prepare('SELECT * FROM reading_sources').first()).toBeNull();
  await env.BUCKET.put(file.storageKey, note);
  expect(await projectReading(env, policy)).toBe('complete');
  expect(await (await list()).json()).toMatchObject({ items: [{ crate_reading_id: id }], issues: [] });
  expect((await getStoredFileRow(env.DB, path))?.storageKey).toBe(file.storageKey);
});

it('repairs durable legacy error rows rather than requiring a source edit or database reset', async () => {
  const { id, file } = await seed();
  await env.DB.prepare(`INSERT INTO reading_sources(path,revision,generation,error) VALUES (?,?,?,?)`)
    .bind(path, file.storageKey, policy.generation, 'This note could not be read as a Reading note. Open it in Obsidian to check its properties.').run();
  expect(await (await list()).json()).toMatchObject({ items: [{ crate_reading_id: id }], issues: [] });
  expect(await (await capture()).json()).toMatchObject({ alreadySaved: true, id });
});

it('retains the previous verified identity and processes healthy neighbors during an outage', async () => {
  const { note, file } = await seed('Reading/A.md');
  await projectReading(env, policy);
  const previous = await env.DB.prepare('SELECT * FROM reading_sources WHERE path=?').bind('Reading/A.md').first();
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/A.md', note + '\nNew personal text.', file.hash);
  await seed('Reading/B.md');
  const read = vi.spyOn(env.BUCKET, 'get').mockRejectedValueOnce(new Error('one unavailable object'));
  expect(await projectReading(env, policy)).toBe('unavailable');
  expect(await env.DB.prepare('SELECT * FROM reading_sources WHERE path=?').bind('Reading/A.md').first()).toEqual(previous);
  expect(await env.DB.prepare('SELECT item_id FROM reading_sources WHERE path=?').bind('Reading/B.md').first()).not.toBeNull();
  read.mockRestore();
  expect(await projectReading(env, policy)).toBe('complete');
  expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, 'Reading/A.md'))?.content).toContain('New personal text.');
});

it('quarantines a verified invalid note once and retries when the source is repaired', async () => {
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, '---\ncrate_reading_version: 1\n---\nInvalid properties.', null);
  expect(await projectReading(env, policy)).toBe('complete');
  const response = await list();
  const body = await response.json() as { items: unknown[]; issues: Array<{ path: string; message: string }> };
  expect(body.items).toEqual([]);
  expect(body.issues[0]?.path).toBe(path);
  expect(body.issues[0]?.message).toContain('invalid properties');
  const read = vi.spyOn(env.BUCKET, 'get');
  expect(await projectReading(env, policy)).toBe('complete');
  expect(read).not.toHaveBeenCalled(); read.mockRestore();
  const id = crypto.randomUUID();
  const note = createReadingNote({ id, url, savedAt: new Date().toISOString() });
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, note, (await getStoredFileRow(env.DB, path))!.hash);
  expect(await (await list()).json()).toMatchObject({ items: [{ crate_reading_id: id }], issues: [] });
});
