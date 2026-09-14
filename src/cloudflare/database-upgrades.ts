import release from './server-release.json';
import { sha256Hex } from './deployment-artifacts';

export interface DatabaseMigration {
  id: string;
  from: number;
  to: number;
  file: string;
  checksum: string;
}

export interface DatabaseRelease {
  revision: number;
  schemaVersion: number;
  minimumSchemaVersion: number;
  migrations: readonly DatabaseMigration[];
}

export const SERVER_RELEASE: DatabaseRelease = release;

// Empty until the first released schema actually needs an upgrade. These SQL
// assets are bundled locally, never fetched or evaluated from a remote source.
const sources = import.meta.glob<string>('./migrations/*.sql', { query: '?raw', import: 'default', eager: true });

export function planDatabaseUpgrade(version: number | null, target: DatabaseRelease = SERVER_RELEASE): DatabaseMigration[] {
  if (!Number.isSafeInteger(target.revision) || target.revision < 1
    || !Number.isSafeInteger(target.minimumSchemaVersion) || target.minimumSchemaVersion < 1
    || !Number.isSafeInteger(target.schemaVersion) || target.schemaVersion < target.minimumSchemaVersion) {
    throw new Error('Invalid server release manifest');
  }
  let next = 1; // Released migration history remains immutable when old sources retire.
  const ids = new Set<string>();
  for (const migration of target.migrations) {
    if (!/^[a-z0-9-]+$/.test(migration.id) || ids.has(migration.id)
      || migration.from !== next || migration.to !== next + 1
      || migration.file !== `${migration.id}.sql` || !/^[a-f0-9]{64}$/.test(migration.checksum)) {
      throw new Error('Invalid database migration chain');
    }
    next = migration.to;
    ids.add(migration.id);
  }
  if (next !== target.schemaVersion) throw new Error('Missing database migration path');
  if (version === null) return [];
  if (!Number.isSafeInteger(version) || version < target.minimumSchemaVersion || version > target.schemaVersion) {
    throw new Error('Unsupported database schema. Use a matching Crate build.');
  }
  return target.migrations.filter(migration => migration.from >= version);
}

export function validateMigrationHistory(version: number, createdVersion: unknown, receipts: readonly Record<string, unknown>[], target: DatabaseRelease = SERVER_RELEASE): void {
  planDatabaseUpgrade(version, target);
  if (!Number.isSafeInteger(createdVersion) || Number(createdVersion) < 1 || Number(createdVersion) > version) throw new Error('Unsupported database schema baseline');
  const expected = target.migrations.filter(migration => migration.from >= Number(createdVersion) && migration.to <= version);
  if (receipts.length !== expected.length || expected.some(migration => !receipts.some(row => row.id === migration.id && row.checksum === migration.checksum))) {
    throw new Error('Database migration history does not match this build. Use its matching recovery tools.');
  }
}

export async function migrationTransaction(migration: DatabaseMigration, sql = sources[`./migrations/${migration.file}`]): Promise<string> {
  if (!sql || await sha256Hex(sql) !== migration.checksum) throw new Error('Database migration failed its integrity check');
  // Run the precondition, DDL/data changes, receipt and version marker in ONE
  // D1 transaction. An unexpected source version deliberately fails CHECK(id=1).
  // Migrations must not contain transaction control or edit these control tables.
  return `INSERT INTO crate_schema(id, version) SELECT 2, 0 WHERE NOT EXISTS (SELECT 1 FROM crate_schema WHERE id = 1 AND version = ${migration.from});
${sql}
INSERT INTO crate_migrations(id, checksum) VALUES ('${migration.id}', '${migration.checksum}');
UPDATE crate_schema SET version = ${migration.to} WHERE id = 1;`;
}
