/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { portablePathKey } from '../../protocol/portable-path';
import { loadStoredFileRows } from './sync-storage';
import { handleGetManifest, handleGetFileMetadata } from './sync-metadata-handlers';
import { meterD1Usage } from './d1-usage';
import { findReferencedStorageKeys } from './storage-references';
import { beginInitialImport } from './initial-import';
import { trackStagedBatch } from './staged-upload-batches';
import { cleanStagedBatches } from './maintenance/staged-batch-cleanup';

const statements = (sql: string) => sql.split(';').map(value => value.trim()).filter(Boolean).map(value => env.DB.prepare(value));
afterEach(reset);

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
  await env.DB.batch(statements(schema));
  if (open) await env.DB.prepare("INSERT INTO initial_import(id, token, state, generation) VALUES (1, 'resume-token', 'importing', 7)").run();
  if (open) expect(await env.DB.prepare('SELECT token, state, generation, snapshot_seq FROM initial_import').first()).toEqual({ token: 'resume-token', state: 'importing', generation: 7, snapshot_seq: 0 });
  else expect(await env.DB.prepare('SELECT * FROM initial_import').first()).toBeNull();
  const started = await (await beginInitialImport(env.DB)).json() as { import: { token: string; state: string } };
  expect(started.import.state).toBe('importing');
  if (open) expect(started.import.token).toBe('resume-token');
});
