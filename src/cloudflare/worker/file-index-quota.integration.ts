import { fileFolderArgs } from './file-identity';
/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { listStoredMarkdownFileMetadataByPrefix } from './storage';
import { beginInitialImport } from './initial-import';
import { pruneInitialImport } from './initial-import-prune';
import { meterD1Usage } from './d1-usage';

async function initialize() {
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
}
beforeEach(initialize);
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it('reads only the selected folder without indexing every Markdown file', async () => {
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10000)
    INSERT INTO files(path, portable_path, storage_key)
    SELECT CASE WHEN x % 2 = 0 THEN 'Other/' ELSE 'Z-other/' END || x || '.md', 'other/' || x || '.md', 'key-' || x FROM n`).run();
  for (const path of ['Reminders/Inbox.md', 'Reminders/Work/Tasks.MD', 'Reminders/image.png', 'Reminders-old/Ignore.md']) {
    await env.DB.prepare('INSERT INTO files(path, portable_path, storage_key) VALUES (?, ?, ?)').bind(path, path.toLowerCase(), path).run();
  }
  const prepare = vi.spyOn(env.DB, 'prepare');
  expect((await listStoredMarkdownFileMetadataByPrefix(env.DB, 'Reminders')).map(file => file.path))
    .toEqual(['Reminders/Inbox.md', 'Reminders/Work/Tasks.MD']);
  const sql = prepare.mock.calls[0]![0];
  const measured = await env.DB.prepare(sql).bind(...fileFolderArgs('Reminders')).all() as { results: unknown[]; meta: { rows_read: number } };
  expect(measured.meta.rows_read).toBeLessThanOrEqual(10);
  const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...fileFolderArgs('Reminders')).all();
  expect(JSON.stringify(plan.results)).toContain('PRIMARY KEY');
});

it('prunes only named paths in a 10,000-file paused import and preserves changed files', async () => {
  const { import: session } = await (await beginInitialImport(env.DB)).json() as { import: { token: string } };
  const hash = 'a'.repeat(64);
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10000)
    INSERT INTO files(path, portable_path, storage_key, hash)
    SELECT 'Notes/' || x || '.md', 'notes/' || x || '.md', 'key-' || x, ? FROM n`).bind(hash).run();
  const meter = meterD1Usage(env.DB);
  const request = () => new Request('https://test', { method: 'POST', body: JSON.stringify({ token: session.token,
    files: [{ path: 'Notes/1.md', hash }, { path: 'Notes/2.md', hash: 'b'.repeat(64) }] }) });
  expect((await pruneInitialImport(request(), meter.db)).status).toBe(200);
  expect(meter.usage.complete).toBe(true);
  expect(meter.usage.rowsRead).toBeLessThan(100);
  expect(await env.DB.prepare("SELECT path FROM files WHERE path = 'Notes/1.md'").first()).toBeNull();
  expect(await env.DB.prepare("SELECT path FROM files WHERE path = 'Notes/2.md'").first()).not.toBeNull();
  expect((await env.DB.prepare('SELECT storage_key FROM object_cleanup_queue').all()).results).toEqual([{ storage_key: 'key-1' }]);
  await env.DB.prepare("UPDATE initial_import SET state = 'complete'").run();
  expect((await pruneInitialImport(request(), env.DB)).status).toBe(409);
});
