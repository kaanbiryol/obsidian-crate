import { SERVER_RELEASE, validateMigrationHistory } from '../database-upgrades';
import type { BackupRow, Cell, UpgradeBackup } from './archive';
import policy from './restore-policy.json';

function discardMaintenanceKey(key: string): boolean {
  return policy.resetMaintenanceKeys.includes(key) || policy.resetMaintenancePrefixes.some(prefix => key.startsWith(prefix));
}

const record = (row: BackupRow): Record<string, Cell> => Object.fromEntries(row.columns.map((column, index) => [column, row.values[index]!]));
const RESET = new Set(['crate_schema', 'crate_release', 'crate_migrations', ...policy.resetTables]);
export function prepareRows(rows: BackupRow[], manifest: UpgradeBackup, currentSchema: string, restoredAt: number): BackupRow[] {
  // Preserve queued captures and Reading policy from the launch schema.
  // Future schema changes require an explicit recovery adapter.
  if (SERVER_RELEASE.schemaVersion > 2) throw new Error('This schema needs a newer in-app restore adapter');
  const allowed = new Set([...currentSchema.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map(match => match[1]));
  allowed.add('sqlite_sequence');
  if (rows.some(row => !allowed.has(row.table))) throw new Error('Unknown backup table');
  const schemaRows = rows.filter(row => row.table === 'crate_schema').map(record);
  const schema = schemaRows[0];
  if (schemaRows.length !== 1 || !schema || schema.id !== 1 || typeof schema.version !== 'number') throw new Error('Invalid backup schema');
  validateMigrationHistory(schema.version, schema.created_version, rows.filter(row => row.table === 'crate_migrations').map(record));
  const refs = new Map<string, { hash: Cell; size: Cell }>();
  for (const row of rows.filter(row => row.table === 'files' || row.table === 'file_versions')) {
    const value = record(row), previous = refs.get(String(value.storage_key));
    if (typeof value.storage_key !== 'string' || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 || previous && (previous.hash !== value.hash || previous.size !== value.size)) throw new Error('Conflicting backup file references');
    refs.set(value.storage_key, { hash: value.hash, size: value.size });
  }
  for (const item of manifest.objects) {
    const ref = refs.get(item.key);
    if (ref ? ref.hash !== item.sha256 || ref.size !== item.size : item.key !== '__crate__/settings.json') throw new Error('Backup inventory does not match its database');
    refs.delete(item.key);
  }
  if (refs.size) throw new Error('Backup is missing file contents');
  return rows.filter(row => !RESET.has(row.table) && !(row.table === 'maintenance_state' && discardMaintenanceKey(String(record(row).key)))).map(row => {
    const copy = { ...row, values: [...row.values] };
    if (row.table === 'file_versions') {
      const index = row.columns.indexOf('expires_at');
      if (index < 0) throw new Error('Backup version has no expiry');
      copy.values[index] = restoredAt + policy.fileVersionRetentionMs;
    }
    if (row.table === 'sqlite_sequence') {
      const value = record(row);
      if (value.name !== 'changelog' || typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 0) throw new Error('Invalid backup sequence');
    }
    return copy;
  });
}
