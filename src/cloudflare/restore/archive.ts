import type { CloudflareApiClient } from '../cloudflare-api';

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
