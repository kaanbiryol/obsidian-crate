/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../../schema.sql?raw';
import { meterD1Usage } from '../d1-usage';
import { writeCommittedMarkdownFile } from '../storage';
import { createReadingNote } from '@/reading/core/notes';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { projectReading } from './projection';
import { handleReadingRoute } from './routes';
import { publishCapture, type PendingCapture } from './captures';
import { runReadingExtraction } from './extraction/jobs';
import { policy } from './common';
import type { Env } from '../types';

const principal = { tokenId: 'vault', scope: 'vault' as const };
const operationId = () => createReminderOperationId(Math.floor(Date.now() / 86400_000));
const route = (target: Env, path: string, body?: Record<string, unknown>) => handleReadingRoute(new Request(`https://test/reading/${path}`,
  body ? { method: 'POST', body: JSON.stringify(body) } : undefined), target, principal);
/** Unrelated files sort on both sides of the Reading folder's primary-key range. */
const UNRELATED_FILES = 10_000;
/** Any scan of files reads at least UNRELATED_FILES rows; primary-key lookups read a few per Reading note. */
const MAX_ROWS_READ = 100;
async function measure<T>(action: (target: Env) => Promise<T>) {
  const meter = meterD1Usage(env.DB);
  const result = await action({ ...env, DB: meter.db });
  expect(meter.usage.complete).toBe(true);
  return { result, rowsRead: meter.usage.rowsRead };
}

beforeEach(async () => {
  await env.DB.batch(schema.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => env.DB.prepare(sql)));
  await env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,0,'Reading','g','r')").run();
  await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO files(path, portable_path, storage_key)
    SELECT CASE x % 3 WHEN 0 THEN 'Notes/' WHEN 1 THEN 'Reading-archive/' ELSE 'Readings/' END || x || '.md',
      CASE x % 3 WHEN 0 THEN 'notes/' WHEN 1 THEN 'reading-archive/' ELSE 'readings/' END || x || '.md', 'key-' || x FROM n`).bind(UNRELATED_FILES).run();
});
afterEach(reset);

it('keeps Reading projection passes independent of unrelated vault files', async () => {
  for (let index = 0; index < 3; index++) {
    const note = createReadingNote({ id: crypto.randomUUID(), url: `https://example.invalid/${index}`, savedAt: new Date().toISOString() });
    await writeCommittedMarkdownFile(env.BUCKET, env.DB, `Reading/${index}.md`, note, null);
  }
  const current = (await policy(env.DB))!;
  const first = await measure(target => projectReading(target, current));
  expect(first.result).toBe('complete');
  expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_sources').first()).toMatchObject({ n: 3 });
  expect(first.rowsRead).toBeLessThan(MAX_ROWS_READ);
  const idle = await measure(target => projectReading(target, current));
  expect(idle.result).toBe('complete');
  expect(idle.rowsRead).toBeLessThan(MAX_ROWS_READ);
});

it('keeps Reading library reads, saves, and extraction cleanup independent of unrelated vault files', async () => {
  const id = crypto.randomUUID(), url = 'https://example.invalid/saved';
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Saved.md', createReadingNote({ id, url, savedAt: new Date().toISOString() }), null);
  const list = await measure(target => route(target, 'list'));
  expect(await list.result.json()).toMatchObject({ items: [{ crate_reading_id: id }], issues: [] });
  const item = await measure(target => route(target, `item?id=${id}`));
  expect(item.result.status).toBe(200);
  const duplicate = await measure(target => route(target, 'capture', { url, operationId: operationId() }));
  expect(await duplicate.result.json()).toMatchObject({ alreadySaved: true, id });
  const bookmark = await measure(target => route(target, 'capture', { url: 'https://example.invalid/bookmark', operationId: operationId() }));
  expect(await bookmark.result.json()).toMatchObject({ saved: true, alreadySaved: false });
  const update = await measure(target => route(target, 'update', { id, before: { favorite: false }, changes: { favorite: true }, operationId: operationId() }));
  expect(update.result.status).toBe(200);

  await env.DB.prepare('UPDATE reading_policy SET enabled = 1').run();
  expect((await route(env, 'capture', { url: 'https://example.invalid/queued', operationId: operationId() })).status).toBe(200);
  const queued = (await env.DB.prepare('SELECT * FROM reading_captures').first<PendingCapture>())!;
  const publish = await measure(target => publishCapture(target, queued.id, queued.generation, null));
  expect(await env.DB.prepare('SELECT 1 FROM reading_captures').first()).toBeNull();
  const state = { storage: { setAlarm: async () => {} } } as unknown as DurableObjectState;
  const alarms = { idFromName: () => ({}), get: () => ({ fetch: async () => new Response(null) }) } as unknown as Env['REMINDER_ALARMS'];
  const extraction = await measure(target => runReadingExtraction(state, { ...target, REMINDER_ALARMS: alarms }));

  const rowsRead = { list, item, duplicate, bookmark, update, publish, extraction };
  for (const [step, measured] of Object.entries(rowsRead)) expect(measured.rowsRead, step).toBeLessThan(MAX_ROWS_READ);
}, 20_000);
