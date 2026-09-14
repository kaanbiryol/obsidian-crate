/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import migration from '../schema-v6.sql?raw';
import { portablePathKey } from '../../protocol/portable-path';
import { getStoredFileRow, loadStoredFileRows, drainObjectCleanupQueue } from './sync-storage';
import { handleGetManifest, handleGetFileMetadata, handleGetChanges } from './sync-metadata-handlers';
import { meterD1Usage } from './d1-usage';
import { findReferencedStorageKeys } from './storage-references';
import { beginInitialImport } from './initial-import';
import { trackStagedBatch } from './staged-upload-batches';
import { cleanStagedBatches } from './maintenance/staged-batch-cleanup';

const statements = (sql: string) => sql.split(';').map(value => value.trim()).filter(Boolean).map(value => env.DB.prepare(value));
async function initializeLegacy(rowid: boolean) {
  const legacy = schema.replace('path TEXT NOT NULL,\n\tportable_path TEXT PRIMARY KEY,', 'path TEXT PRIMARY KEY,\n\tportable_path TEXT NOT NULL,')
    .replace(/\n {1,2}file_path TEXT,/g, '')
    .replace('VALUES (1, 6)', 'VALUES (1, 5)').replace('UPDATE crate_schema SET version = 6', 'UPDATE crate_schema SET version = 5')
    .replace('DROP INDEX IF EXISTS files_portable_path_idx;', 'CREATE UNIQUE INDEX files_portable_path_idx ON files(portable_path);')
    .replace('DROP INDEX IF EXISTS files_storage_key_idx;', 'CREATE INDEX files_storage_key_idx ON files(storage_key);');
  await env.DB.batch(statements(rowid ? legacy.replace('storage_key TEXT NOT NULL\n) WITHOUT ROWID', 'storage_key TEXT NOT NULL\n)') : legacy));
}
afterEach(reset);

it.each([true, false])('migrates an existing inventory atomically and preserves metadata/history (rowid=%s)', async rowid => {
  await initializeLegacy(rowid);
  for (const path of ['Z.md', 'alpha.md', 'École/İstanbul.md', 'Cafe\u0301/Note.md']) {
    await env.DB.prepare('INSERT INTO files(path, portable_path, hash, size, storage_key) VALUES (?, ?, ?, 4, ?)')
      .bind(path, portablePathKey(path), 'hash', path).run();
    await env.BUCKET.put(path, 'data');
  }
  await env.DB.prepare("INSERT INTO file_versions(storage_key, path, hash, size, reason, expires_at) VALUES ('retained', 'Z.md', 'hash', 4, 'replaced', 9999999999999)").run();
  await env.DB.prepare("INSERT INTO object_cleanup_queue(storage_key) VALUES ('Z.md'), ('retained'), ('unused')").run();
  await env.BUCKET.put('retained', 'data');
  await env.BUCKET.put('unused', 'old');
  const before = (await env.DB.prepare('SELECT * FROM files ORDER BY path').all()).results;
  // A failed statement must roll back both DDL and the data copy.
  await expect(env.DB.batch([...statements(migration), env.DB.prepare('INSERT INTO crate_schema(id, version) VALUES (2, 6)')])).rejects.toThrow();
  expect((await env.DB.prepare('SELECT * FROM files ORDER BY path').all()).results).toEqual(before);
  expect(await env.DB.prepare('SELECT version FROM crate_schema').first()).toEqual({ version: 5 });
  expect((await env.DB.prepare('PRAGMA table_info(files)').all<{ name: string; pk: number }>()).results.find(column => column.name === 'path')?.pk).toBe(1);
  await env.DB.batch(statements(migration));
  await env.DB.batch(statements(schema));
  expect(await (await handleGetChanges(new Request('https://test?since=0'), env.DB)).json()).toMatchObject({ cursorExpired: true, lastSeq: 1 });
  const log = await env.DB.prepare("INSERT INTO changelog(path, action) VALUES ('later.md', 'put') RETURNING seq").all<{ seq: number }>();
  expect(log.results[0]?.seq).toBe(2);
  expect((await env.DB.prepare('SELECT * FROM files ORDER BY path').all()).results).toEqual(before);
  expect((await env.DB.prepare('PRAGMA table_info(files)').all<{ name: string; pk: number }>()).results.find(column => column.name === 'portable_path')?.pk).toBe(1);
  expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'files'").all()).results).toEqual([]);
  expect(await getStoredFileRow(env.DB, 'École/İstanbul.md')).toMatchObject({ hash: 'hash', storageKey: 'École/İstanbul.md' });
  expect(await getStoredFileRow(env.DB, 'école/i\u0307stanbul.md')).toBeNull();
  await drainObjectCleanupQueue(env.BUCKET, env.DB);
  expect(await env.BUCKET.head('Z.md')).not.toBeNull();
  expect(await env.BUCKET.head('retained')).not.toBeNull();
  expect(await env.BUCKET.head('unused')).toBeNull();
});

it('pages by portable identity while returning original spelling and rejecting alias reads', async () => {
  await env.DB.batch(statements(schema));
  const paths = ['Z.md', 'alpha.md', 'École/İstanbul.md', 'Cafe\u0301/Note.md'];
  for (const path of paths) await env.DB.prepare('INSERT INTO files(path, portable_path, storage_key) VALUES (?, ?, ?)').bind(path, portablePathKey(path), path).run();
  let after: string | undefined;
  const received: string[] = [];
  do {
    const page = await (await handleGetManifest(new Request(`https://test?limit=1${after ? `&after=${encodeURIComponent(after)}` : ''}`), env.DB)).json() as { files: Record<string, unknown>; nextCursor?: string };
    received.push(...Object.keys(page.files)); after = page.nextCursor;
  } while (after);
  expect(received).toEqual(['alpha.md', 'Cafe\u0301/Note.md', 'Z.md', 'École/İstanbul.md']);
  expect((await loadStoredFileRows(env.DB, ['z.md'])).size).toBe(0);
  const metadata: unknown = await (await handleGetFileMetadata(new Request('https://test', { method: 'POST', body: JSON.stringify({ paths: ['z.md', 'Z.md'] }) }), env.DB)).json();
  expect(metadata).toEqual({ files: { 'Z.md': { hash: '', size: 0, modified: expect.any(String) as string, revision: 'Z.md' } } });
});

it('cleans owned batches using primary lookups among 10,000 files and protects retained objects', async () => {
  await env.DB.batch(statements(schema));
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10000)
    INSERT INTO files(path, portable_path, storage_key) SELECT 'Note-' || x, 'note-' || x, 'key-' || x FROM n`).run();
  await env.DB.prepare("INSERT INTO file_versions(storage_key, path, hash, size, reason, expires_at) VALUES ('retained', 'Note-1', 'hash', 1, 'replaced', 9999999999999)").run();
  const objects = [{ path: 'Note-1', storageKey: 'key-1' }, { path: 'Note-1', storageKey: 'retained' }, { path: 'Note-1', storageKey: 'obsolete' }];
  const meter = meterD1Usage(env.DB);
  expect(await findReferencedStorageKeys(meter.db, objects)).toEqual(new Set(['key-1', 'retained']));
  expect(meter.usage.rowsRead).toBeLessThan(15);
  for (const object of objects) await env.BUCKET.put(object.storageKey, 'x');
  const id = await trackStagedBatch(env.DB, objects);
  await env.DB.prepare('UPDATE staged_upload_batches SET expires_at = 1 WHERE id = ?').bind(id).run();
  expect(await cleanStagedBatches(env.BUCKET, env.DB)).toBe(3);
  expect(await env.BUCKET.head('key-1')).not.toBeNull();
  expect(await env.BUCKET.head('retained')).not.toBeNull();
  expect(await env.BUCKET.head('obsolete')).toBeNull();
});

it.each([false, true])('preserves initial-import eligibility and any saved progress (open=%s)', async open => {
  await initializeLegacy(true);
  if (open) await env.DB.prepare("INSERT INTO initial_import(id, token, state, generation) VALUES (1, 'resume-token', 'importing', 7)").run();
  await env.DB.batch(statements(migration));
  await env.DB.batch(statements(schema));
  if (open) expect(await env.DB.prepare('SELECT token, state, generation, snapshot_seq FROM initial_import').first()).toEqual({ token: 'resume-token', state: 'importing', generation: 7, snapshot_seq: 1 });
  else expect(await env.DB.prepare('SELECT * FROM initial_import').first()).toBeNull();
  const started = await (await beginInitialImport(env.DB)).json() as { import: { token: string; state: string } };
  expect(started.import.state).toBe('importing');
  if (open) expect(started.import.token).toBe('resume-token');
});
