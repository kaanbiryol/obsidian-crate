import { prepareRows } from './prepare-rows';
import { CloudflareApiError, type CloudflareApiClient } from '../cloudflare-api';
import type { CloudflareDeploymentArtifacts } from '../deployment-artifacts';
import { sha256Hex } from '../deployment-artifacts';
import { provisionCloudflareDeployment } from '../provisioner';
import { recoverDeployment } from '../deployment-recovery';
import { completePublishedDeployment } from '../complete-published-deployment';
import { hashBytes, literal, parseBackupRows, PREFIX, quote, readBackup, type BackupChoice, type BackupRow, type BackupSource } from './archive';
import { validRestoreState, type ServerRestoreState } from './state';

export async function listUpgradeBackups(api: CloudflareApiClient, source: BackupSource): Promise<BackupChoice[]> {
  const choices: BackupChoice[] = [], cursors = new Set<string>(); let cursor: string | undefined;
  do {
    const page = await api.listR2Objects(source.account, source.bucket, cursor);
    for (const key of page.keys) {
      const prefix = key.replace(/\/archive\.json$/, '');
      if (key.endsWith('/archive.json') && PREFIX.test(prefix)) choices.push(await readBackup(api, source, prefix));
    }
    cursor = page.cursor;
    if (cursor && cursors.has(cursor)) throw new Error('Backup listing did not advance');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return choices.sort((a, b) => Date.parse(b.manifest.createdAt) - Date.parse(a.manifest.createdAt));
}
const MARKER = 'crate_restore_progress';
export function rowSql(row: BackupRow, expected: string): string {
  const guard = `EXISTS (SELECT 1 FROM maintenance_state WHERE key='${MARKER}' AND value=${literal(expected)})`;
  if (row.table === 'sqlite_sequence') {
    const name = row.values[row.columns.indexOf('name')];
    if (typeof name !== 'string') throw new Error('Invalid backup sequence');
    return `DELETE FROM sqlite_sequence WHERE name=${literal(name)} AND ${guard};\nINSERT INTO sqlite_sequence(${row.columns.map(quote).join(',')}) SELECT ${row.values.map(literal).join(',')} WHERE ${guard};`;
  }
  return `INSERT INTO ${quote(row.table)}(${row.columns.map(quote).join(',')}) SELECT ${row.values.map(literal).join(',')} WHERE ${guard};`;
}
function rowBatches(rows: BackupRow[], plan: string): string[] {
  const batches: string[] = []; let buffer = '', count = 0;
  for (const row of rows) {
    const statement = rowSql(row, `${plan}:${batches.length}`);
    if (new TextEncoder().encode(statement).length > 70_000) throw new Error('A database row is too large for in-app restore. Use the recovery CLI.');
    if (buffer && (buffer.length + statement.length > 20_000 || count >= 40)) { batches.push(buffer); buffer = ''; count = 0; }
    // Regenerate the guard after starting another batch.
    buffer += rowSql(row, `${plan}:${batches.length}`) + '\n'; count++;
  }
  if (buffer) batches.push(buffer);
  return batches.map((sql, index) => sql + `UPDATE maintenance_state SET value=${literal(`${plan}:${index + 1}`)} WHERE key='${MARKER}' AND value=${literal(`${plan}:${index}`)};`);
}
async function verifyRows(api: CloudflareApiClient, account: string, database: string, rows: BackupRow[], schema: string): Promise<void> {
  const groups = new Map<string, BackupRow[]>();
  for (const row of rows) { const group = groups.get(row.table) ?? []; group.push(row); groups.set(row.table, group); }
  // Fresh control rows and the separately verified projection queue are generated locally.
  const generated = new Set(['crate_schema', 'maintenance_state', 'notification_projection_jobs']);
  for (const table of [...schema.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map(match => match[1]!)) {
    if (!groups.has(table) && !generated.has(table)) {
      const unexpected = (await api.queryD1(account, database, `SELECT 1 FROM ${quote(table)} LIMIT 1;`)).flatMap(item => item.results ?? []);
      if (unexpected.length) throw new Error(`Unexpected data in restored ${table}`);
    }
  }
  if (!groups.has('maintenance_state')) groups.set('maintenance_state', []);
  for (const [table, expected] of groups) {
    const columns = expected[0]?.columns ?? ['key','value','updated_at'];
    if (expected.some(row => JSON.stringify(row.columns) !== JSON.stringify(columns))) throw new Error('Inconsistent backup columns');
    const actual: string[] = [];
    for (let offset = 0; ; offset += 500) {
      const result = (await api.queryD1(account, database, `SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}${table === 'maintenance_state' ? ` WHERE key != '${MARKER}'` : ''} LIMIT 500 OFFSET ${offset};`)).flatMap(item => item.results ?? []);
      actual.push(...result.map(row => JSON.stringify(columns.map(column => row[column]))));
      if (result.length < 500) break;
    }
    if (JSON.stringify(actual.sort()) !== JSON.stringify(expected.map(row => JSON.stringify(row.values)).sort())) throw new Error(`Restored ${table} did not match the backup. The target remains disconnected.`);
  }
}

export async function restoreUpgradeBackup(input: {
  api: CloudflareApiClient; state: ServerRestoreState; artifacts: CloudflareDeploymentArtifacts;
  save: () => Promise<void>; onProgress: (message: string) => void;
}): Promise<string> {
  const { api, state, artifacts, save, onProgress } = input;
  if (!validRestoreState(state) || state.fingerprint !== artifacts.fingerprint) throw new Error('Restore state belongs to a different server or build. Resume with the original build.');
  const { source, target } = state, account = source.account;
  const backup = await readBackup(api, source, state.prefix);
  if (backup.hash !== state.archiveHash) throw new Error('The selected backup changed');
  if (state.phase === 'complete') return `https://${target.workerName}.${target.workersSubdomain}.workers.dev`;
  if (state.phase === 'copying') {
    onProgress('Verifying the backup database and file inventory…');
    const databaseBytes = await api.getRecoveryObject(account, source.bucket, `${state.prefix}/database.sql`);
    if (databaseBytes.length > 128 * 1024 * 1024) throw new Error('Backup database is too large for in-app recovery. Use the recovery CLI.');
    if (await hashBytes(databaseBytes) !== backup.manifest.databaseSha256) throw new Error('Backup database checksum does not match');
    const rows = prepareRows(parseBackupRows(new TextDecoder().decode(databaseBytes)), backup.manifest, artifacts.d1Schema, state.restoredAt);
    const plan = await sha256Hex(JSON.stringify([state.archiveHash, state.fingerprint, state.restoredAt, rows]));
    const batches = rowBatches(rows, plan);
    // Verify every archived object before creating destination resources.
    const backupKey = async (key: string) => `${state.prefix}/objects/${await sha256Hex(key)}`;
    for (const [index, item] of backup.manifest.objects.entries()) {
      const bytes = await api.getRecoveryObject(account, source.bucket, await backupKey(item.key));
      if (bytes.length !== item.size || await hashBytes(bytes) !== item.sha256) throw new Error('A backup file failed verification');
      onProgress(`Verifying backup: ${index + 1} of ${backup.manifest.objects.length} files and versions…`);
    }
    onProgress('Preparing separate restore storage…');
    if (!target.d1DatabaseId) {
      const existing = await api.findD1Database(account, target.d1DatabaseName);
      const created = existing ?? await api.createD1Database(account, target.d1DatabaseName);
      if (!created.uuid || created.uuid === source.database) throw new Error('Invalid restore database');
      target.d1DatabaseId = created.uuid; await save();
    }
    const database = target.d1DatabaseId;
    const found = await api.getD1Database(account, database);
    if (found?.name !== target.d1DatabaseName) throw new Error('Restore database identity changed');
    // No Worker may be attached while data is being copied.
    try { await api.getWorkerSettings(account, target.workerName); throw new Error('Restore target already has a Worker'); }
    catch (error) { if (!(error instanceof CloudflareApiError && error.status === 404)) throw error; }
    if (!await api.getR2Bucket(account, target.r2BucketName)) await api.createR2Bucket(account, target.r2BucketName);
    const query = async (sql: string) => (await api.queryD1(account, database, sql)).flatMap(item => item.results ?? []);
    const tables = await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';");
    if (!tables.length) await query(`${artifacts.d1Schema}\nINSERT INTO maintenance_state(key,value) VALUES ('${MARKER}',${literal(`${plan}:0`)});`);
    const marker = (await query(`SELECT value FROM maintenance_state WHERE key='${MARKER}';`))[0]?.value;
    const progress = typeof marker === 'string' && marker.startsWith(`${plan}:`) ? Number(marker.slice(plan.length + 1)) : -1;
    if (!Number.isSafeInteger(progress) || progress < 0 || progress > batches.length + 1) throw new Error('Restore storage belongs to another operation');
    const allowedKeys = new Set(backup.manifest.objects.map(item => item.key));
    let cursor: string | undefined; const cursors = new Set<string>();
    do {
      const page = await api.listR2Objects(account, target.r2BucketName, cursor);
      if (page.keys.some(key => !allowedKeys.has(key))) throw new Error('Restore bucket contains unrelated files');
      cursor = page.cursor;
      if (cursor && cursors.has(cursor)) throw new Error('Restore bucket listing did not advance');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    for (const [index, item] of backup.manifest.objects.entries()) {
      let bytes: Uint8Array;
      try { bytes = await api.getRecoveryObject(account, target.r2BucketName, item.key); }
      catch (error) {
        if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
        const original = await api.getRecoveryObject(account, source.bucket, await backupKey(item.key));
        if (original.length !== item.size || await hashBytes(original) !== item.sha256) throw new Error('Backup file changed during restore');
        await api.putRestoredObject(account, source.bucket, target.r2BucketName, item.key, original);
        bytes = await api.getRecoveryObject(account, target.r2BucketName, item.key);
      }
      if (bytes.length !== item.size || await hashBytes(bytes) !== item.sha256) throw new Error('Restore file differs from the backup; it was not overwritten');
      onProgress(`Restoring files and history: ${index + 1} of ${backup.manifest.objects.length} verified…`);
    }
    for (let index = progress; index < batches.length; index++) {
      await query(batches[index]!);
      onProgress(`Restoring database: ${index + 1} of ${batches.length} batches…`);
    }
    await verifyRows(api, account, database, rows, artifacts.d1Schema);
    // Rebuild derived reminder schedules only after the preserved data is verified.
    const finalMarker = `${plan}:${batches.length}`;
    await query(`INSERT INTO notification_projection_jobs(path,job_token,updated_at)
SELECT path,storage_key,datetime(${state.restoredAt} / 1000,'unixepoch') FROM files
WHERE lower(path) LIKE '%.md' AND EXISTS (SELECT 1 FROM notification_policy WHERE id=1 AND path >= folder_path || '/' AND path < folder_path || '0')
AND EXISTS (SELECT 1 FROM maintenance_state WHERE key='${MARKER}' AND value=${literal(finalMarker)});
UPDATE maintenance_state SET value=${literal(`${plan}:${batches.length + 1}`)} WHERE key='${MARKER}' AND value=${literal(finalMarker)};`);
    const queueMismatch = await query(`SELECT path,job_token FROM notification_projection_jobs EXCEPT
SELECT path,storage_key FROM files WHERE lower(path) LIKE '%.md' AND EXISTS (SELECT 1 FROM notification_policy WHERE id=1 AND path >= folder_path || '/' AND path < folder_path || '0');`);
    const missingJobs = await query(`SELECT path,storage_key FROM files WHERE lower(path) LIKE '%.md' AND EXISTS (SELECT 1 FROM notification_policy WHERE id=1 AND path >= folder_path || '/' AND path < folder_path || '0') EXCEPT SELECT path,job_token FROM notification_projection_jobs;`);
    if (queueMismatch.length || missingJobs.length) throw new Error('Restored notification queue did not match');
    if ((await query('PRAGMA integrity_check;')).some(row => row.integrity_check !== 'ok')) throw new Error('Restored database integrity check failed');
    state.phase = 'publishing'; await save();
  }
  onProgress('Publishing and verifying the restored server…');
  const recovery = await recoverDeployment(api, target, artifacts.fingerprint);
  if (recovery.status === 'blocked') throw new Error(recovery.message);
  if (recovery.status === 'verify' && recovery.resumeValue) await completePublishedDeployment(api, target, artifacts, recovery.resumeValue);
  else if (recovery.status !== 'completed') await provisionCloudflareDeployment({ api, accountId: account, metadata: target, artifacts, onMetadataChanged: save, onProgress, resumeUpdateValue: recovery.status === 'resume' ? recovery.resumeValue : undefined });
  state.phase = 'complete'; await save();
  return `https://${target.workerName}.${target.workersSubdomain}.workers.dev`;
}
