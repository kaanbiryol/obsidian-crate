import type { CloudflareApiClient } from '../cloudflare-api';
import { SERVER_RELEASE, validateMigrationHistory } from '../database-upgrades';

export interface BackupSource { account: string; database: string; bucket: string }
interface BackupObject { key: string; sha256: string; size: number; contentType?: string }
export interface UpgradeBackup { format: 1; complete: true; createdAt: string; source: BackupSource; databaseSha256: string; objects: BackupObject[] }
export interface BackupChoice { prefix: string; manifest: UpgradeBackup; hash: string }
export type Cell = string | number | null;
export interface BackupRow { table: string; columns: string[]; values: Cell[] }
export const PREFIX = /^__crate__\/backups\/schema-upgrade-[a-f0-9-]{36}$/;
export const quote = (name: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Unsupported backup identifier'); return `"${name}"`; };
export const literal = (value: Cell): string => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`;
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function readBackup(api: Pick<CloudflareApiClient, 'getRecoveryObject'>, source: BackupSource, prefix: string): Promise<BackupChoice> {
  if (!PREFIX.test(prefix)) throw new Error('Invalid backup location');
  const bytes = await api.getRecoveryObject(source.account, source.bucket, `${prefix}/archive.json`);
  if (bytes.length > 32 * 1024 * 1024) throw new Error('Backup inventory is too large for in-app recovery');
  const value = JSON.parse(new TextDecoder().decode(bytes)) as UpgradeBackup;
  if (!value || value.format !== 1 || value.complete !== true || !Number.isFinite(Date.parse(value.createdAt))
    || !value.source || Object.keys(source).some(key => source[key as keyof BackupSource] !== value.source[key as keyof BackupSource])
    || !/^[a-f0-9]{64}$/.test(value.databaseSha256) || !Array.isArray(value.objects)) throw new Error('Backup is incomplete or belongs to a different server');
  const keys = new Set<string>();
  for (const item of value.objects) {
    if (!item || typeof item.key !== 'string' || !item.key || item.key.length > 1024 || keys.has(item.key)
      || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error('Invalid backup inventory');
    keys.add(item.key);
  }
  return { prefix, manifest: value, hash: await hashBytes(bytes) };
}

/** Decode only the literal INSERTs emitted by our checkpoint writer. Never execute downloaded SQL. */
export function parseBackupRows(sql: string): BackupRow[] {
  const statements: string[] = [];
  let start = 0, quoted = '';
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (quoted) { if (char === quoted) { if (sql[i + 1] === quoted) i++; else quoted = ''; } }
    else if (char === "'" || char === '"') quoted = char;
    else if (char === ';') { statements.push(sql.slice(start, i).trim()); start = i + 1; }
  }
  if (quoted || sql.slice(start).trim()) throw new Error('Incomplete backup database');
  const rows: BackupRow[] = [];
  for (const statement of statements) {
    if (!statement || /^PRAGMA foreign_keys=OFF$/i.test(statement) || /^CREATE (?:TABLE|(?:UNIQUE )?INDEX)\b/i.test(statement) || statement === 'DELETE FROM sqlite_sequence') continue;
    const insert = /^INSERT INTO "([a-z_][a-z0-9_]*)"\s*\(([^)]+)\) VALUES \(([\s\S]*)\)$/i.exec(statement)
      ?? /^INSERT INTO (sqlite_sequence)\(([^)]+)\) VALUES \(([\s\S]*)\)$/i.exec(statement);
    if (!insert) throw new Error('Unsupported statement in backup database');
    const columns = insert[2]!.split(',').map(value => value.trim().replace(/^"([a-z_][a-z0-9_]*)"$/, '$1'));
    columns.forEach(quote);
    const values: Cell[] = [];
    const data = insert[3]!; let offset = 0;
    while (offset < data.length) {
      while (/\s/.test(data[offset] ?? '') && offset < data.length) offset++;
      if (data[offset] === "'") {
        offset++; let value = '', closed = false;
        while (offset < data.length) {
          if (data[offset] === "'") { if (data[offset + 1] === "'") { value += "'"; offset += 2; } else { offset++; closed = true; break; } }
          else value += data[offset++];
        }
        if (!closed) throw new Error('Invalid quoted backup value');
        values.push(value);
      } else {
        const end = data.indexOf(',', offset), token = data.slice(offset, end < 0 ? undefined : end).trim();
        if (token === 'NULL') values.push(null);
        else if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(token) && Number.isFinite(Number(token)) && (!Number.isInteger(Number(token)) || Number.isSafeInteger(Number(token)))) values.push(Number(token));
        else throw new Error('Non-literal backup value');
        offset = end < 0 ? data.length : end;
      }
      while (offset < data.length && /\s/.test(data[offset]!)) offset++;
      if (offset < data.length && (data[offset++] !== ',' || !data.slice(offset).trim())) throw new Error('Invalid backup value separator');
    }
    if (values.length !== columns.length || new Set(columns).size !== columns.length) throw new Error('Backup row shape does not match');
    rows.push({ table: insert[1]!, columns, values });
  }
  return rows;
}
const record = (row: BackupRow): Record<string, Cell> => Object.fromEntries(row.columns.map((column, index) => [column, row.values[index]!]));
const RESET = new Set(['crate_schema', 'crate_release', 'crate_migrations', 'auth_tokens', 'push_subscriptions', 'web_enrollment_tokens', 'scheduled_reminders', 'notification_jobs', 'reminder_projections', 'reminder_file_cache', 'object_cleanup_queue', 'staged_uploads', 'staged_upload_batches', 'request_rate_limits', 'notification_projection_jobs', 'reminder_source_state', 'reading_sources', 'reading_jobs', 'reading_enrollments', 'reading_handoffs']);
export function prepareRows(rows: BackupRow[], manifest: UpgradeBackup, currentSchema: string, restoredAt: number): BackupRow[] {
  // Schema 1→2 adds Reading tables; 2→3 adds a defaulted column. Future data
  // transformations must add an explicit recovery adapter before enabling them.
  if (SERVER_RELEASE.schemaVersion > 3) throw new Error('This schema needs a newer in-app restore adapter');
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
  return rows.filter(row => !RESET.has(row.table) && !(row.table === 'maintenance_state' && /^(crate_deployment_fence|crate_upgrade_checkpoint|crate_restore_|reminder_source_scan)/.test(String(record(row).key)))).map(row => {
    const copy = { ...row, values: [...row.values] };
    if (row.table === 'file_versions') {
      const index = row.columns.indexOf('expires_at');
      if (index < 0) throw new Error('Backup version has no expiry');
      copy.values[index] = restoredAt + 30 * 86400_000;
    }
    if (row.table === 'sqlite_sequence') {
      const value = record(row);
      if (value.name !== 'changelog' || typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 0) throw new Error('Invalid backup sequence');
    }
    return copy;
  });
}
