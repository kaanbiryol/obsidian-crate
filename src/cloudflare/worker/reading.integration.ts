/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { handleReadingRoute } from './reading/routes';
import { projectReading } from './reading/projection';
import { publishExtraction } from './reading/extraction/jobs';
import type { Publication } from './reading/extraction/jobs';
import { policy } from './reading/common';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from './storage';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { parseReadingNote, updateReadingNote } from '@/reading/core/notes';
import { commitFileDelete } from './sync-mutations';
import { getStoredFileRow } from './sync-storage';

const principal = { tokenId: 'vault', scope: 'vault' as const };
const command = (path: string, body: Record<string, unknown>) => handleReadingRoute(new Request(`https://test/reading/${path}`, { method: 'POST', body: JSON.stringify(body) }), env, principal);
const id = () => createReminderOperationId(Math.floor(Date.now() / 86400_000));
beforeEach(async () => {
  await env.DB.batch(schema.split(';').map(value => value.trim()).filter(Boolean).map(value => env.DB.prepare(value)));
  await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','test-hash')").run();
  expect((await command('policy', { enabled: true, folderPath: 'Reading', revision: null })).status).toBe(200);
});
afterEach(reset);
async function capture() {
  const response = await command('capture', { url: 'https://example.com/article', operationId: id() });
  expect(response.status, await response.clone().text()).toBe(200);
  await projectReading(env, (await policy(env.DB))!);
  return (await env.DB.prepare('SELECT * FROM reading_jobs').first<Publication['job']>())!;
}
it('publishes extracted text through immutable file versions and ordinary sync changelog', async () => {
  const job = await capture();
  await publishExtraction(env, { job, result: { markdown: '# Article\n\nUseful saved article text.', title: 'An article', author: 'Author' }, resolvedUrl: job.url });
  const saved = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path);
  expect(saved?.content).toContain('Useful saved article text.');
  expect(parseReadingNote(saved!.content)).toMatchObject({ extraction_status: 'ready', title: 'An article', author: 'Author' });
  expect((await env.DB.prepare('SELECT count(*) AS n FROM changelog WHERE path=?').bind(job.path).first())?.n).toBe(2);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM file_versions').first())?.n).toBe(1);
});
it('cannot resurrect a deleted source or overwrite text changed during extraction', async () => {
  const job = await capture(), source = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))!;
  const changed = source.content + '\nMy personal note.\n';
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, job.path, changed, source.hash);
  await publishExtraction(env, { job, result: { markdown: 'Stale extraction must not overwrite a changed source.', title: undefined, author: undefined } });
  expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))?.content).toBe(changed);
  const file = (await getStoredFileRow(env.DB, job.path))!;
  await commitFileDelete(env.BUCKET, env.DB, { path: job.path, previousFile: file, expectedHash: file.hash, expectedRevision: file.storageKey });
  await publishExtraction(env, { job, result: null });
  expect(await getStoredFileRow(env.DB, job.path)).toBeNull();
});
it('preserves user notes and metadata already present when extraction starts', async () => {
  const original = await capture(), source = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, original.path))!;
  const edited = updateReadingNote(source.content, original.item_id, { favorite: true, tags: ['kept'] }) + '\nPersonal thoughts.\n';
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, original.path, edited, source.hash);
  await env.DB.prepare('DELETE FROM reading_jobs').run(); await env.DB.prepare('DELETE FROM reading_sources').run();
  await projectReading(env, (await policy(env.DB))!);
  const job = (await env.DB.prepare('SELECT * FROM reading_jobs').first<Publication['job']>())!;
  await publishExtraction(env, { job, result: { markdown: 'Saved article content, separate from the personal note.', title: undefined, author: undefined } });
  const saved = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))!;
  expect(saved.content).toContain('Personal thoughts.'); expect(parseReadingNote(saved.content)).toMatchObject({ favorite: true, tags: ['kept'], extraction_status: 'ready' });
});
it('keeps failed extractions as useful bookmarks and never extracts clipper notes', async () => {
  const job = await capture(); await publishExtraction(env, { job, result: null });
  const saved = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))!;
  expect(parseReadingNote(saved.content)).toMatchObject({ source_url: job.url, extraction_status: 'unavailable' });
  const clipped = saved.content.replace('"url"', '"web-clipper"').replace('"unavailable"', '"pending"');
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, job.path, clipped, saved.hash);
  await projectReading(env, (await policy(env.DB))!);
  expect(await env.DB.prepare('SELECT 1 FROM reading_jobs').first()).toBeNull();
});
it('replays a lost receipt even after deletion and rejects expired operation identities', async () => {
  const body = { url: 'https://example.com/retry', operationId: id() };
  const first = await command('capture', body); const payload: unknown = await first.json();
  const file = (await env.DB.prepare('SELECT path FROM files').first<{ path: string }>())!, stored = (await getStoredFileRow(env.DB, file.path))!;
  await commitFileDelete(env.BUCKET, env.DB, { path: file.path, previousFile: stored, expectedHash: stored.hash, expectedRevision: stored.storageKey });
  expect(await (await command('capture', body)).json()).toEqual(payload); expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
  expect((await command('capture', { url: body.url, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000) - 180) })).status).toBe(410);
});
