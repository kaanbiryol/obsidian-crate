/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { migrationTransaction } from '../database-upgrades';
import { sha256Hex } from '../deployment-artifacts';

afterEach(reset);
const statements = (sql: string) => sql.split(';').map(value => value.trim()).filter(Boolean).map(value => env.DB.prepare(value));

it('future migrations atomically preserve files, record completion, and reject repeat application', async () => {
  await env.DB.batch(statements(schema));
  await env.DB.prepare("INSERT INTO files(path, portable_path, hash, storage_key) VALUES ('A.md', 'a.md', 'hash', 'original')").run();
  await env.BUCKET.put('original', 'unchanged');
  const sql = 'CREATE TABLE example (id TEXT PRIMARY KEY); INSERT INTO example(id) VALUES (\'new-feature\');';
  const migration = { id: 'add-example', from: 1, to: 2, file: 'add-example.sql', checksum: await sha256Hex(sql) };
  const transaction = await migrationTransaction(migration, sql);
  // Failure after DDL, copy, receipt and marker must roll everything back.
  await expect(env.DB.batch([...statements(transaction), env.DB.prepare('INSERT INTO crate_schema(id, version) VALUES (2, 2)')])).rejects.toThrow();
  expect(await env.DB.prepare('SELECT version FROM crate_schema').first()).toEqual({ version: 1 });
  expect((await env.DB.prepare('SELECT * FROM crate_migrations').all()).results).toEqual([]);
  expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'example'").first()).toBeNull();
  await env.DB.batch(statements(transaction));
  expect(await env.DB.prepare('SELECT version FROM crate_schema').first()).toEqual({ version: 2 });
  expect(await env.DB.prepare('SELECT id, checksum FROM crate_migrations').first()).toEqual({ id: migration.id, checksum: migration.checksum });
  await expect(env.DB.batch(statements(transaction))).rejects.toThrow();
  expect(await env.DB.prepare('SELECT path, hash, storage_key FROM files').first()).toEqual({ path: 'A.md', hash: 'hash', storage_key: 'original' });
  expect(await (await env.BUCKET.get('original'))!.text()).toBe('unchanged');
});
