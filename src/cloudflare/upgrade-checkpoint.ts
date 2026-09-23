import type { CloudflareApiClient } from './cloudflare-api';
import { sha256Hex } from './deployment-artifacts';
import type { DeploymentFence } from './deployment-fence';

const CONTROL = new Set(['maintenance_state', 'crate_schema', 'crate_migrations', 'crate_release']);
const quoteName = (name: string) => `"${name.replace(/"/g, '""')}"`;
const quoteValue = (value: unknown): string => value === null ? 'NULL' : typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : (() => { throw new Error('Unsupported database value in upgrade checkpoint'); })();
export function upgradeGuards(table: string): string {
  if (CONTROL.has(table)) return '';
  return ['INSERT', 'UPDATE', 'DELETE'].map(action => `CREATE TRIGGER IF NOT EXISTS ${quoteName(`crate_upgrade_${table}_${action}`)} BEFORE ${action} ON ${quoteName(table)} BEGIN SELECT RAISE(ABORT, 'Crate server upgrade in progress'); END;`).join('\n');
}
export function removeUpgradeGuards(table: string): string {
  return ['INSERT', 'UPDATE', 'DELETE'].map(action => `DROP TRIGGER IF EXISTS ${quoteName(`crate_upgrade_${table}_${action}`)};`).join('\n');
}

/** The old Worker need not understand Reading: database triggers fence its mutations too. */
export async function createUpgradeCheckpoint(input: { api: CloudflareApiClient; accountId: string; databaseId: string; bucketName: string; fence: DeploymentFence; onProgress?: (message: string) => void }): Promise<void> {
  const { api, accountId, databaseId, bucketName, fence } = input;
  const rows = async (sql: string) => (await api.queryD1(accountId, databaseId, sql)).flatMap(result => result.results ?? []);
  const definitions = await rows("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type DESC, name;");
  const tables = definitions.filter(row => row.type === 'table').map(row => String(row.name));
  if (!tables.includes('files') || !tables.includes('crate_schema')) throw new Error('Cannot back up an unrecognized server database');
  fence.requireVerification();
  await fence.mutate(() => api.queryD1(accountId, databaseId, tables.map(upgradeGuards).join('\n')), 'freeze-upgrade-data');
  const prefix = `__crate__/backups/schema-upgrade-${crypto.randomUUID()}`;
  input.onProgress?.('Backing up the server database. Large servers can take several minutes…');
  let sql = 'PRAGMA foreign_keys=OFF;\n';
  for (const row of definitions.filter(row => row.type === 'table')) {
    const table = String(row.name); sql += `${String(row.sql)};\n`;
    for (let offset = 0;; offset += 500) {
      const page = await rows(`SELECT * FROM ${quoteName(table)} LIMIT 500 OFFSET ${offset};`);
      for (const record of page) sql += `INSERT INTO ${quoteName(table)} (${Object.keys(record).map(quoteName).join(',')}) VALUES (${Object.values(record).map(quoteValue).join(',')});\n`;
      if (page.length < 500) break;
      if (sql.length > 128 * 1024 * 1024) throw new Error('Database checkpoint exceeds the in-app backup limit. Use Crate recovery tools before upgrading.');
    }
  }
  sql += definitions.filter(row => row.type === 'index').map(row => `${String(row.sql)};`).join('\n');
  // Preserve an AUTOINCREMENT cursor even when all older changelog rows were pruned.
  const sequences = await rows('SELECT name, seq FROM sqlite_sequence;');
  sql += '\nDELETE FROM sqlite_sequence;\n' + sequences.map(row => `INSERT INTO sqlite_sequence(name,seq) VALUES (${quoteValue(row.name)},${quoteValue(row.seq)});`).join('\n');
  const databaseSha256 = await sha256Hex(sql);
  await api.putRecoveryObject(accountId, bucketName, `${prefix}/database.sql`, new TextEncoder().encode(sql));
  const verifiedSql = await api.getRecoveryObject(accountId, bucketName, `${prefix}/database.sql`);
  if (await hash(verifiedSql) !== databaseSha256) throw new Error('Database checkpoint verification failed');
  const objects: Array<{ key: string; sha256: string; size: number; contentType: string }> = [];
  input.onProgress?.('Counting files and history for the backup…');
  const refs = await rows('SELECT storage_key, hash, size FROM files UNION SELECT storage_key, hash, size FROM file_versions;');
  const uniqueRefs = new Map<string, (typeof refs)[number]>();
  for (const row of refs) {
    const key = String(row.storage_key);
    const previous = uniqueRefs.get(key);
    if (previous) {
      if (`${String(previous.hash)}:${String(previous.size)}` !== `${String(row.hash)}:${String(row.size)}`) throw new Error('Conflicting file references in checkpoint');
      continue;
    }
    uniqueRefs.set(key, row);
  }
  const total = uniqueRefs.size;
  let lastReportedAt = 0;
  const reportFiles = (verified: number) => {
    const now = Date.now();
    // The dialog announces status changes to screen readers; avoid announcing every file in a large vault.
    if (verified > 0 && verified < total && now - lastReportedAt < 5_000) return;
    lastReportedAt = now;
    input.onProgress?.(`Backing up files and history: ${verified.toLocaleString()} of ${total.toLocaleString()} verified. This may take several minutes…`);
  };
  if (total) reportFiles(0);
  for (const [key, row] of uniqueRefs) {
    const bytes = await api.getRecoveryObject(accountId, bucketName, key);
    if (bytes.byteLength !== row.size || await hash(bytes) !== row.hash) throw new Error('A server file could not be verified. Upgrade has not started.');
    const backupKey = `${prefix}/objects/${await sha256Hex(key)}`;
    await api.putRecoveryObject(accountId, bucketName, backupKey, bytes);
    if (await hash(await api.getRecoveryObject(accountId, bucketName, backupKey)) !== row.hash) throw new Error('File checkpoint verification failed');
    objects.push({ key, sha256: String(row.hash), size: bytes.byteLength, contentType: 'application/octet-stream' });
    reportFiles(objects.length);
  }
  input.onProgress?.('Finishing and verifying the backup archive…');
  try {
    const key = '__crate__/settings.json', bytes = await api.getRecoveryObject(accountId, bucketName, key);
    const sha = await hash(bytes), backupKey = `${prefix}/objects/${await sha256Hex(key)}`;
    await api.putRecoveryObject(accountId, bucketName, backupKey, bytes);
    if (await hash(await api.getRecoveryObject(accountId, bucketName, backupKey)) !== sha) throw new Error('Settings checkpoint verification failed');
    objects.push({ key, sha256: sha, size: bytes.byteLength, contentType: 'application/json' });
  } catch (error) { if (!(error instanceof Error && error.message === 'Recovery object unavailable (404)')) throw error; }
  const manifest = JSON.stringify({ format: 1, complete: true, createdAt: new Date().toISOString(), source: { account: accountId, database: databaseId, bucket: bucketName }, bookmark: null, databaseSha256, objects });
  await api.putRecoveryObject(accountId, bucketName, `${prefix}/archive.json`, new TextEncoder().encode(manifest));
  if (await hash(await api.getRecoveryObject(accountId, bucketName, `${prefix}/archive.json`)) !== await sha256Hex(manifest)) throw new Error('Checkpoint manifest verification failed');
  await fence.mutate(() => api.queryD1(accountId, databaseId, "INSERT OR REPLACE INTO maintenance_state(key,value) VALUES ('crate_upgrade_checkpoint', ?);", [prefix]), 'verify-upgrade-checkpoint');
}
async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function releaseUpgradeGuards(api: Pick<CloudflareApiClient, 'queryD1'>, account: string, database: string, fence: DeploymentFence) {
  const rows = (await api.queryD1(account, database, "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'crate_upgrade_%';")).flatMap(result => result.results ?? []);
  if (rows.length) await fence.mutate(() => api.queryD1(account, database, rows.map(row => `DROP TRIGGER ${quoteName(String(row.name))};`).join('\n')), 'resume-upgraded-server');
}
