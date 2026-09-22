import { expect, it } from 'vitest';
import { migrationTransaction, planDatabaseUpgrade, validateMigrationHistory, SERVER_RELEASE, type DatabaseMigration } from './database-upgrades';
import { sha256Hex } from './deployment-artifacts';

const step: DatabaseMigration = { id: 'add-example', from: 1, to: 2, file: 'add-example.sql', checksum: 'a'.repeat(64) };
const future = { revision: 2, minimumSchemaVersion: 1, schemaVersion: 2, migrations: [step] };

it('ships schema two with a checksummed upgrade from the released baseline', () => {
  expect(SERVER_RELEASE).toMatchObject({ schemaVersion: 2, minimumSchemaVersion: 1 });
  expect(planDatabaseUpgrade(null)).toEqual([]);
  expect(planDatabaseUpgrade(1)).toHaveLength(1);
  expect(planDatabaseUpgrade(2)).toEqual([]);
  for (const version of [0, 3, 4, 5, 6, 999, NaN]) expect(() => planDatabaseUpgrade(version)).toThrow('Unsupported database schema');
});

it('plans skipped releases in order and skips completed steps', () => {
  const next = { ...step, id: 'add-next', file: 'add-next.sql', from: 2, to: 3 };
  const target = { ...future, schemaVersion: 3, migrations: [step, next] };
  expect(planDatabaseUpgrade(1, target)).toEqual([step, next]);
  expect(planDatabaseUpgrade(2, target)).toEqual([next]);
  expect(planDatabaseUpgrade(3, target)).toEqual([]);
  expect(planDatabaseUpgrade(null, target)).toEqual([]);
});

it('rejects missing paths, edited manifest identities and unsupported source versions', () => {
  expect(() => planDatabaseUpgrade(1, { ...future, migrations: [] })).toThrow('Missing');
  for (const invalid of [{ ...step, from: 0 }, { ...step, to: 3 }, { ...step, file: '../other.sql' }, { ...step, checksum: 'invalid' }]) {
    expect(() => planDatabaseUpgrade(1, { ...future, migrations: [invalid] })).toThrow('Invalid');
  }
  expect(() => planDatabaseUpgrade(3, future)).toThrow('Unsupported');
});

it('verifies exact migration bytes before assembling an atomic upgrade', async () => {
  const sql = 'CREATE TABLE example (id TEXT PRIMARY KEY);';
  const migration = { ...step, checksum: await sha256Hex(sql) };
  const transaction = await migrationTransaction(migration, sql);
  expect(transaction).toContain(sql);
  expect(transaction).toContain('INSERT INTO crate_migrations');
  await expect(migrationTransaction(migration, sql + ' ')).rejects.toThrow('integrity');
});

it('distinguishes fresh future installs from databases that must retain migration receipts', () => {
  expect(() => validateMigrationHistory(2, 2, [], future)).not.toThrow();
  expect(() => validateMigrationHistory(2, 1, [], future)).toThrow('history');
  expect(() => validateMigrationHistory(2, 1, [{ id: step.id, checksum: step.checksum }], future)).not.toThrow();
  expect(() => validateMigrationHistory(2, 1, [{ id: step.id, checksum: 'edited' }], future)).toThrow('history');
  expect(() => validateMigrationHistory(2, 3, [], future)).toThrow('baseline');
  const retired = { ...future, minimumSchemaVersion: 2 };
  expect(() => planDatabaseUpgrade(1, retired)).toThrow('Unsupported');
  expect(() => validateMigrationHistory(2, 1, [{ id: step.id, checksum: step.checksum }], retired)).not.toThrow();
});
