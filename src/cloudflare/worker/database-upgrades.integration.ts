/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import currentSchema from '../schema.sql?raw';
import { migrationTransaction, planDatabaseUpgrade } from '../database-upgrades';
import { sha256Hex } from '../deployment-artifacts';
import { inspectDeploymentDatabase } from '../deployment-database';

afterEach(reset);
const statements = (sql: string) => sql.split(';').map(value => value.trim()).filter(Boolean).map(value => env.DB.prepare(value));

it('accepts the launch baseline without rewriting it', async () => {
  await env.DB.batch(statements(currentSchema));
  await env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,1,'Reading','generation','revision')").run();
  const schemaHash = await sha256Hex(currentSchema);
  await env.DB.prepare('INSERT INTO crate_release(id,revision,fingerprint,schema_version,schema_hash) VALUES (1,108,?,1,?)')
    .bind('fa545843b4883f775e970cdf4b8d4760fe1a8f199a28052fe635c4f03c5df45e', schemaHash).run();
  const queries: string[] = [];
  const input = {
    api: { queryD1: async (_account: string, _database: string, sql: string) => {
      queries.push(sql);
      return [await env.DB.prepare(sql).all<Record<string, unknown>>()];
    } },
    accountId: 'account', databaseId: 'database',
    artifacts: { version: '0.3.0', fingerprint: 'f'.repeat(64), workerBundle: '', workerBundleSha256: '', d1Schema: currentSchema, d1SchemaSha256: schemaHash },
  };
  await expect(inspectDeploymentDatabase(input)).resolves.toBe(1);
  expect(planDatabaseUpgrade(1)).toEqual([]);
  expect(queries.every(sql => sql.startsWith('SELECT '))).toBe(true);
  expect(await env.DB.prepare('SELECT folder_path FROM reading_policy').first()).toEqual({ folder_path: 'Reading' });
  expect(await env.DB.prepare('SELECT version,created_version FROM crate_schema').first()).toEqual({ version: 1, created_version: 1 });
  await env.DB.prepare("UPDATE crate_release SET schema_hash='edited' WHERE id=1").run();
  await expect(inspectDeploymentDatabase(input)).rejects.toThrow('definition changed');
});

it.each([2, 3, 4])('rejects historical schema %i without an upgrade path', async version => {
  expect(() => planDatabaseUpgrade(version)).toThrow('Unsupported database schema');
});

it('future migrations atomically preserve files, record completion, and reject repeat application', async () => {
  await env.DB.batch(statements(currentSchema));
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
