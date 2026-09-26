/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../migrations/schema-v1.sql?raw';
import schemaV2 from '../migrations/schema-v2.sql?raw';
import currentSchema from '../schema.sql?raw';
import { migrationTransaction, planDatabaseUpgrade, SERVER_RELEASE } from '../database-upgrades';
import { sha256Hex } from '../deployment-artifacts';
import { inspectDeploymentDatabase } from '../deployment-database';

afterEach(reset);
const statements = (sql: string) => sql.split(';').map(value => value.trim()).filter(Boolean).map(value => env.DB.prepare(value));

it.each([1, 2, 3])('accepts an already deployed schema-3 database created at schema %i without rewriting it', async createdVersion => {
  await env.DB.batch(statements(createdVersion === 1 ? schema : createdVersion === 2 ? schemaV2 : currentSchema));
  for (const step of planDatabaseUpgrade(createdVersion)) await env.DB.batch(statements(await migrationTransaction(step)));
  await env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision,browser_rendering) VALUES (1,1,'Reading','generation','revision',1)").run();
  const schemaHash = await sha256Hex(currentSchema);
  await env.DB.prepare('INSERT INTO crate_release(id,revision,fingerprint,schema_version,schema_hash) VALUES (1,108,?,3,?)')
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
  await expect(inspectDeploymentDatabase(input)).resolves.toBe(3);
  expect(planDatabaseUpgrade(3)).toEqual([]);
  expect(queries.every(sql => sql.startsWith('SELECT '))).toBe(true);
  expect(await env.DB.prepare('SELECT browser_rendering FROM reading_policy').first()).toEqual({ browser_rendering: 1 });
  expect(await env.DB.prepare('SELECT version,created_version FROM crate_schema').first()).toEqual({ version: 3, created_version: createdVersion });
  if (createdVersion < 3) {
    await env.DB.prepare("UPDATE crate_migrations SET checksum='edited' WHERE id='003-reading-browser'").run();
    await expect(inspectDeploymentDatabase(input)).rejects.toThrow('migration history');
  }
  await env.DB.prepare("UPDATE crate_release SET schema_hash='edited' WHERE id=1").run();
  await expect(inspectDeploymentDatabase(input)).rejects.toThrow('definition changed');
});

it.each([1, 2])('upgrades schema %i with browser rendering off and preserves existing Reading and file data', async version => {
  await env.DB.batch(statements(version === 1 ? schema : schemaV2));
  await env.DB.prepare("INSERT INTO files(path,portable_path,hash,storage_key) VALUES ('A.md','a.md','hash','original')").run();
  await env.BUCKET.put('original', 'unchanged');
  if (version === 2) await env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,1,'Reading','generation','revision')").run();
  for (const step of planDatabaseUpgrade(version)) {
    const sql = await migrationTransaction(step);
    if (step.to === 3) {
      await expect(env.DB.batch([...statements(sql), env.DB.prepare('INSERT INTO missing_table VALUES (1)')])).rejects.toThrow();
      expect((await env.DB.prepare('SELECT version FROM crate_schema').first())?.version).toBe(2);
    }
    await env.DB.batch(statements(sql));
    await expect(env.DB.batch(statements(sql))).rejects.toThrow();
  }
  expect((await env.DB.prepare('SELECT version FROM crate_schema').first())?.version).toBe(SERVER_RELEASE.schemaVersion);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM crate_migrations').first())?.n).toBe(3 - version);
  if (version === 2) expect(await env.DB.prepare('SELECT * FROM reading_policy').first()).toMatchObject({ enabled: 1, browser_rendering: 0, folder_path: 'Reading', generation: 'generation', revision: 'revision' });
  expect((await env.DB.prepare('SELECT storage_key FROM files').first())?.storage_key).toBe('original');
  expect(await (await env.BUCKET.get('original'))!.text()).toBe('unchanged');
});

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
