/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../storage';
import { createReadingNote, updateReadingNote } from '@/reading/core/notes';
import { writeCommittedMarkdownMove } from '../sync/atomic-markdown-move';
import { commitFileDelete } from '../sync/mutations';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { ensureReadingIndex } from './library-index';
import { readStoredNote } from './common';
import { handleReadingRoute } from './routes';
import { getStoredFileRow } from '../sync/storage';
import { runNotificationCoordinator } from '../notifications/coordinator';
import { sha256Hex } from '@/platform/sha256';

const policy = { enabled: 0, folder_path: 'Reading', generation: 'g', revision: 'r' };
const principal = { tokenId: 'vault', scope: 'vault' as const };
const url = 'https://example.invalid/read';
const path = 'Reading/Note.md';
const list = () => handleReadingRoute(new Request('https://test/reading/list'), env, principal);
const index = async (current = policy) => (await ensureReadingIndex(env, current, file => readStoredNote(env, file))).state;
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
  await applySchema(env.DB);
  await env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,0,'Reading','g','r')").run();
  await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
});
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await reset(); });

it('schedules rebuild recovery with a delay and stops once the index is complete', async () => {
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
  expect(await env.DB.prepare('SELECT * FROM reading_items').first()).toBeNull();
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
  expect(await index()).toBe('unavailable');
  expect(await env.DB.prepare('SELECT * FROM reading_items').first()).toBeNull();
  await env.BUCKET.put(file.storageKey, note);
  expect(await index()).toBe('complete');
  expect(await (await list()).json()).toMatchObject({ items: [{ crate_reading_id: id }], issues: [] });
  expect((await getStoredFileRow(env.DB, path))?.storageKey).toBe(file.storageKey);
});

it('indexes edits, new notes, moves and deletions in their commits without reading R2', async () => {
  const { id, note, file } = await seed('Reading/A.md');
  expect(await index()).toBe('complete');
  const read = vi.spyOn(env.BUCKET, 'get');
  const edited = updateReadingNote(note, id, { favorite: true });
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/A.md', edited, file.hash);
  const added = await seed('Reading/B.md');
  expect(await index()).toBe('complete');
  const listed = await (await list()).json() as { items: Array<{ crate_reading_id: string; favorite: boolean; path: string }> };
  expect(listed.items.map(item => [item.path, item.favorite])).toEqual([['Reading/A.md', true], ['Reading/B.md', false]]);
  await writeCommittedMarkdownMove(env.BUCKET, env.DB, { source: { path: 'Reading/B.md', expectedHash: added.file.hash, expectedRevision: added.file.storageKey },
    destination: { path: 'Archive/B.md', content: added.note } });
  const current = (await getStoredFileRow(env.DB, 'Reading/A.md'))!;
  await commitFileDelete(env.BUCKET, env.DB, { path: 'Reading/A.md', previousFile: current, expectedHash: current.hash, expectedRevision: current.storageKey });
  expect(await (await list()).json()).toMatchObject({ items: [], issues: [] });
  expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_items').first()).toMatchObject({ n: 0 });
  expect(read).not.toHaveBeenCalled();
  expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, 'Archive/B.md'))?.content).toBe(added.note);
});

it('flags duplicate Reading IDs when the second copy commits and clears them when one is removed', async () => {
  const { note } = await seed('Reading/A.md');
  expect(await index()).toBe('complete');
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/B.md', note, null);
  expect(await (await list()).json()).toMatchObject({ items: [], issues: [{ path: 'Reading/A.md' }, { path: 'Reading/B.md' }] });
  const copy = (await getStoredFileRow(env.DB, 'Reading/B.md'))!;
  await commitFileDelete(env.BUCKET, env.DB, { path: 'Reading/B.md', previousFile: copy, expectedHash: copy.hash, expectedRevision: copy.storageKey });
  expect(await (await list()).json()).toMatchObject({ items: [{ path: 'Reading/A.md' }], issues: [] });
});

it('quarantines a verified invalid note once and retries when the source is repaired', async () => {
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, '---\ncrate_reading_version: 1\n---\nInvalid properties.', null);
  expect(await index()).toBe('complete');
  const response = await list();
  const body = await response.json() as { items: unknown[]; issues: Array<{ path: string; message: string }> };
  expect(body.items).toEqual([]);
  expect(body.issues[0]?.path).toBe(path);
  expect(body.issues[0]?.message).toContain('invalid properties');
  const read = vi.spyOn(env.BUCKET, 'get');
  expect(await index()).toBe('complete');
  expect(read).not.toHaveBeenCalled(); read.mockRestore();
  const id = crypto.randomUUID();
  const note = createReadingNote({ id, url, savedAt: new Date().toISOString() });
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, note, (await getStoredFileRow(env.DB, path))!.hash);
  expect(await (await list()).json()).toMatchObject({ items: [{ crate_reading_id: id }], issues: [] });
});

it.each([
  ['invalid UTF-8', (note: string) => new Uint8Array([...new TextEncoder().encode(note), 0xff]), 1],
  ['a byte order mark', (note: string) => new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(note)]), 0],
])('keeps the library available when a note is saved with %s', async (_name, encode, expectedIssues) => {
  const { id, note, file } = await seed();
  const bytes = encode(note);
  await env.BUCKET.put(file.storageKey, bytes);
  await env.DB.prepare('UPDATE files SET hash = ?, size = ? WHERE path = ?').bind(await sha256Hex(bytes), bytes.byteLength, path).run();
  expect(await index()).toBe('complete');
  const response = await list();
  expect(response.status).toBe(200);
  const body = await response.json() as { items: Array<{ crate_reading_id: string }>; issues: unknown[] };
  expect(body.issues).toHaveLength(expectedIssues);
  expect(body.items.map(item => item.crate_reading_id)).toEqual(expectedIssues ? [] : [id]);
});

it('keeps a byte order mark when the Worker updates the note', async () => {
  const { id, note, file } = await seed();
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(note)]);
  await env.BUCKET.put(file.storageKey, bytes);
  await env.DB.prepare('UPDATE files SET hash = ?, size = ? WHERE path = ?').bind(await sha256Hex(bytes), bytes.byteLength, path).run();
  expect(await index()).toBe('complete');
  const response = await handleReadingRoute(new Request('https://test/reading/update', { method: 'POST', body: JSON.stringify({
    id, changes: { favorite: true }, before: { favorite: false }, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)),
  }) }), env, principal);
  expect(response.status, await response.clone().text()).toBe(200);
  const saved = (await getStoredFileRow(env.DB, path))!;
  const stored = new Uint8Array(await (await env.BUCKET.get(saved.storageKey))!.arrayBuffer());
  expect([...stored.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(stored)).toBe(`\uFEFF${updateReadingNote(note, id, { favorite: true })}`);
});

it('reports the library revisions around an edit so a cached library can follow it without a reload', async () => {
  const { id } = await seed();
  const first = await list();
  const before = first.headers.get('ETag');
  expect(before).toBeTruthy();
  const response = await handleReadingRoute(new Request('https://test/reading/update', { method: 'POST', body: JSON.stringify({
    id, changes: { favorite: true }, before: { favorite: false }, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)),
  }) }), env, principal);
  const body = await response.json() as { library: { before: string; after: string } };
  expect(body.library.before).toBe(before);
  const after = await handleReadingRoute(new Request('https://test/reading/list', { headers: { 'If-None-Match': body.library.after } }), env, principal);
  expect(after.status).toBe(304);
});
