import { prepareRows } from './prepare-rows';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudflareApiError, type CloudflareApiClient } from '../cloudflare-api';
import { sha256Hex, type CloudflareDeploymentArtifacts } from '../deployment-artifacts';
import { createUpgradeCheckpoint } from '../upgrade-checkpoint';
import { SERVER_RELEASE } from '../database-upgrades';
import type { DeploymentFence } from '../deployment-fence';
import { provisionCloudflareDeployment } from '../provisioner';
import { recoverDeployment } from '../deployment-recovery';
import { completePublishedDeployment } from '../complete-published-deployment';
import { listUpgradeBackups, restoreUpgradeBackup, rowSql } from './server-restore';
import { hashBytes, parseBackupRows, readBackup } from './archive';
import type { ServerRestoreState } from './state';
import { normalizeCrateSettings } from '../../plugin/settings';
import policyFixture from '../../../tests/fixtures/recovery/restore-policy.json';

vi.mock('../provisioner', () => ({ provisionCloudflareDeployment: vi.fn(async () => undefined) }));
vi.mock('../deployment-recovery', () => ({ recoverDeployment: vi.fn(async () => ({ status: 'ready' })) }));
vi.mock('../complete-published-deployment', () => ({ completePublishedDeployment: vi.fn(async () => undefined) }));
const schema = readFileSync('src/cloudflare/schema.sql', 'utf8');
const source = { account: 'a'.repeat(32), database: '11111111-1111-1111-1111-111111111111', bucket: 'source-bucket' };
const destination = '22222222-2222-2222-2222-222222222222';
const openDatabases: DatabaseSync[] = [];
const database = () => { const db = new DatabaseSync(':memory:'); openDatabases.push(db); return db; };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(recoverDeployment).mockResolvedValue({ status: 'ready', message: '', diagnostics: '' }); });
afterEach(() => { openDatabases.splice(0).forEach(db => db.close()); });

async function fixture(extraRows = 0) {
  const original = database(); original.exec(schema);
  const bytes = new TextEncoder().encode("Private 'note';\n日本語"), oldBytes = new Uint8Array([0, 255, 12, 99]);
  original.prepare('INSERT INTO files(path,portable_path,hash,size,storage_key) VALUES (?,?,?,?,?)').run("Reminders/a's.md", "reminders/a's.md", await hashBytes(bytes), bytes.length, 'live-object');
  original.prepare('INSERT INTO file_versions(storage_key,path,hash,size,reason,expires_at) VALUES (?,?,?,?,?,?)').run('old-object', "Reminders/a's.md", await hashBytes(oldBytes), oldBytes.length, 'replaced', 1);
  original.exec("INSERT INTO auth_tokens(id,token_hash) VALUES ('old-device','private-token'); INSERT INTO notification_policy(id,folder_path,timezone,revision) VALUES(1,'Reminders','Europe/Berlin','policy'); INSERT INTO changelog(seq,path,action) VALUES(90,'test.md','put'); DELETE FROM changelog;");
  original.prepare('INSERT INTO reminder_operations(operation_id,request_hash,response_json) VALUES (?,?,?)').run('op', 'request-hash', JSON.stringify({ text: "'hello'; 日本語\n\"world\"" }));
  original.exec("INSERT INTO maintenance_state(key,value) VALUES ('retained','hello'),('reminder_source_scan_old','obsolete');");
  original.exec("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,1,'Reading','generation','revision');");
  for (let index = 0; index < extraRows; index++) original.prepare('INSERT INTO reminder_identities(reminder_id,created_operation_id) VALUES (?,?)').run(`id-${index}`, 'operation');
  const buckets = new Map<string, Map<string, Uint8Array>>([[source.bucket, new Map([['live-object', bytes], ['old-object', oldBytes], ['__crate__/settings.json', new TextEncoder().encode('{"setting":true}')]])]]);
  const databases = new Map([[source.database, original]]);
  const names = new Map<string, string>();
  let afterQuery: ((sql: string) => void) | undefined;
  const api = {
    queryD1: vi.fn(async (_account: string, id: string, sql: string, params: string[] = []) => {
      const db = databases.get(id)!;
      if (/^(SELECT|PRAGMA)/.test(sql.trim())) return [{ results: db.prepare(sql).all(...params) }];
      db.exec('BEGIN');
      try { if (params.length) db.prepare(sql).run(...params); else db.exec(sql); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      if (id !== source.database) afterQuery?.(sql);
      return [{ results: [] }];
    }),
    getRecoveryObject: vi.fn(async (_account: string, bucket: string, key: string) => {
      const bytes = buckets.get(bucket)?.get(key); if (!bytes) throw new CloudflareApiError('Object not found', 404, null); return bytes;
    }),
    putRecoveryObject: vi.fn(async (_account: string, bucket: string, key: string, bytes: Uint8Array) => { buckets.get(bucket)!.set(key, bytes); }),
    putRestoredObject: vi.fn(async (_account: string, _sourceBucket: string, bucket: string, key: string, bytes: Uint8Array) => { buckets.get(bucket)!.set(key, bytes); }),
    listR2Objects: vi.fn(async (_account: string, bucket: string) => ({ keys: [...buckets.get(bucket)!.keys()] })),
    findD1Database: vi.fn(async (_account: string, name: string) => names.has(name) ? { uuid: names.get(name), name } : null),
    createD1Database: vi.fn(async (_account: string, name: string) => { databases.set(destination, database()); names.set(name, destination); return { uuid: destination, name }; }),
    getD1Database: vi.fn(async (_account: string, id: string) => ({ uuid: id, name: [...names].find(([, value]) => value === id)?.[0] })),
    getWorkerSettings: vi.fn(async () => { throw new CloudflareApiError('Missing', 404, null); }),
    getR2Bucket: vi.fn(async (_account: string, name: string) => buckets.has(name) ? { name } : null),
    createR2Bucket: vi.fn(async (_account: string, name: string) => { buckets.set(name, new Map()); return { name }; }),
  };
  const client = api as unknown as CloudflareApiClient;
  const fence = { requireVerification: vi.fn(), mutate: <T>(operation: () => Promise<T>) => operation() } as unknown as DeploymentFence;
  await createUpgradeCheckpoint({ api: client, accountId: source.account, databaseId: source.database, bucketName: source.bucket, fence });
  const choice = (await listUpgradeBackups(client, source))[0]!;
  const id = 'abcdef0123456789', name = `crate-${id}`;
  const artifacts: CloudflareDeploymentArtifacts = { version: '0.3.0', fingerprint: 'f'.repeat(64), d1Schema: schema, d1SchemaSha256: await sha256Hex(schema), workerBundle: 'worker', workerBundleSha256: await sha256Hex('worker') };
  const state: ServerRestoreState = { id, source, prefix: choice.prefix, archiveHash: choice.hash, restoredAt: 1234567890000, fingerprint: artifacts.fingerprint, phase: 'copying', target: {
    deploymentId: id, accountId: source.account, accountName: 'Account', vaultName: 'Vault (restored)', workerName: name, d1DatabaseName: name, d1DatabaseId: null, r2BucketName: name, workersSubdomain: 'test', lastDeployedVersion: null, lastDeployedFingerprint: null,
  } };
  const snapshots: ServerRestoreState[] = [];
  const save = vi.fn(async () => { snapshots.push(structuredClone(state)); });
  const run = () => restoreUpgradeBackup({ api: client, state, artifacts, save, onProgress: vi.fn() });
  const rewriteSQL = async (transform: (sql: string) => string) => {
    const bucket = buckets.get(source.bucket)!;
    const bytes = new TextEncoder().encode(transform(new TextDecoder().decode(bucket.get(`${choice.prefix}/database.sql`))));
    bucket.set(`${choice.prefix}/database.sql`, bytes);
    choice.manifest.databaseSha256 = await hashBytes(bytes);
    const manifest = new TextEncoder().encode(JSON.stringify(choice.manifest));
    bucket.set(`${choice.prefix}/archive.json`, manifest); state.archiveHash = await hashBytes(manifest);
  };
  api.queryD1.mockClear(); api.putRecoveryObject.mockClear();
  return { api, client, state, choice, artifacts, run, snapshots, buckets, original, databases, rewriteSQL, interrupt: (handler: (sql: string) => void) => { afterQuery = handler; } };
}

it('restores launch-baseline checkpoints, keeps history and receipts, and requires fresh enrollment', async () => {
  const f = await fixture();
  const sourceBytes = [...f.buckets.get(source.bucket)!].map(([key, value]) => [key, [...value]]);
  expect(await f.run()).toBe(`https://${f.state.target.workerName}.test.workers.dev`);
  const restored = f.databases.get(destination)!;
  expect(restored.prepare('SELECT version,created_version FROM crate_schema').get()).toEqual({ version: SERVER_RELEASE.schemaVersion, created_version: SERVER_RELEASE.schemaVersion });
  expect(restored.prepare('SELECT * FROM files').all()).toEqual(f.original.prepare('SELECT * FROM files').all());
  expect(restored.prepare('SELECT * FROM reminder_operations').all()).toEqual(f.original.prepare('SELECT * FROM reminder_operations').all());
  expect(restored.prepare('SELECT expires_at FROM file_versions').get()).toEqual({ expires_at: f.state.restoredAt + 2592000000 });
  expect(restored.prepare('SELECT * FROM auth_tokens').all()).toEqual([]);
  expect(restored.prepare('SELECT * FROM sqlite_sequence').get()).toEqual({ name: 'changelog', seq: 90 });
  expect(restored.prepare('SELECT path,job_token FROM notification_projection_jobs').get()).toEqual({ path: "Reminders/a's.md", job_token: 'live-object' });
  expect(restored.prepare('SELECT folder_path FROM reading_policy').get()).toEqual({ folder_path: 'Reading' });
  expect([...f.buckets.get(source.bucket)!].map(([key, value]) => [key, [...value]])).toEqual(sourceBytes);
  expect(f.api.queryD1.mock.calls.every(([, id]) => id === destination)).toBe(true);
  expect(f.api.putRecoveryObject).not.toHaveBeenCalled();
  expect(provisionCloudflareDeployment).toHaveBeenCalledOnce();
  expect(f.snapshots.map(state => state.phase)).toEqual(['copying', 'publishing', 'complete']);
  expect(normalizeCrateSettings({ cloudflareRestore: f.state, cloudflareDeployment: f.state.target }, '.obsidian').cloudflareDeployment).toMatchObject({ workerName: f.state.target.workerName });
});

it('applies the shared CLI/in-app policy fixture without retaining source operation markers', async () => {
  const f = await fixture();
  await f.rewriteSQL(sql => sql + readFileSync('tests/fixtures/recovery/restore-policy.sql', 'utf8'));
  await f.run();
  const restored = f.databases.get(destination)!;
  for (const key of policyFixture.discardedKeys) {
    if (key === 'crate_restore_progress') {
      expect(restored.prepare('SELECT value FROM maintenance_state WHERE key = ?').get(key)).not.toEqual({ value: 'old plan:3' });
    } else expect(restored.prepare('SELECT value FROM maintenance_state WHERE key = ?').get(key)).toBeUndefined();
  }
  for (const [key, value] of Object.entries(policyFixture.retainedState)) expect(restored.prepare('SELECT value FROM maintenance_state WHERE key = ?').get(key)).toEqual({ value });
  for (const table of policyFixture.emptyTables) expect(restored.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  for (const [table, row] of Object.entries(policyFixture.preservedRows)) expect(restored.prepare(`SELECT * FROM ${table}`).all()).toEqual([expect.objectContaining(row)]);
});

it.each([403, 503])('does not overwrite a destination object when its read fails with %s', async status => {
  const f = await fixture();
  const read = f.api.getRecoveryObject.getMockImplementation()!;
  f.api.getRecoveryObject.mockImplementation(async (...args) => {
    if (args[1] !== source.bucket) throw new CloudflareApiError('Unavailable', status, null);
    return read(...args);
  });
  await expect(f.run()).rejects.toMatchObject({ status });
  expect(f.api.putRestoredObject).not.toHaveBeenCalled();
  expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
});

it('resumes a committed batch whose acknowledgement was lost without duplicate rows or object uploads', async () => {
  const f = await fixture(); let failed = false;
  f.interrupt(sql => { if (!failed && sql.includes('UPDATE maintenance_state SET value=')) { failed = true; throw new Error('Lost acknowledgement'); } });
  await expect(f.run()).rejects.toThrow('Lost acknowledgement');
  const target = f.state.target.d1DatabaseId, uploads = f.api.putRestoredObject.mock.calls.length;
  expect(f.state.phase).toBe('copying'); expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
  await f.run();
  expect(f.state.target.d1DatabaseId).toBe(target);
  expect(f.api.createD1Database).toHaveBeenCalledOnce();
  expect(f.api.putRestoredObject).toHaveBeenCalledTimes(uploads);
  expect(f.databases.get(destination)!.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 1 });
});

it('resumes after the derived queue committed before acknowledgement', async () => {
  const f = await fixture(); let failed = false;
  f.interrupt(sql => { if (!failed && sql.startsWith('INSERT INTO notification_projection_jobs')) { failed = true; throw new Error('Lost acknowledgement'); } });
  await expect(f.run()).rejects.toThrow('Lost acknowledgement');
  await expect(f.run()).resolves.toContain('.workers.dev');
  expect(f.databases.get(destination)!.prepare('SELECT COUNT(*) AS n FROM notification_projection_jobs').get()).toEqual({ n: 1 });
});

it('resumes an upload with a lost acknowledgement by verifying its bytes', async () => {
  const f = await fixture(); const upload = f.api.putRestoredObject.getMockImplementation()!;
  f.api.putRestoredObject.mockImplementationOnce(async (...args) => { await upload(...args); throw new Error('Lost upload acknowledgement'); });
  await expect(f.run()).rejects.toThrow('Lost upload acknowledgement');
  await f.run();
  expect(f.api.putRestoredObject).toHaveBeenCalledTimes(3);
});

it.each(['corrupt', 'missing'])('rejects a %s archived object before creating any destination', async mode => {
  const f = await fixture(); const key = `${f.choice.prefix}/objects/${await sha256Hex('live-object')}`;
  if (mode === 'corrupt') f.buckets.get(source.bucket)!.set(key, new Uint8Array([1])); else f.buckets.get(source.bucket)!.delete(key);
  await expect(f.run()).rejects.toThrow();
  expect(f.api.createD1Database).not.toHaveBeenCalled(); expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
});

it('rejects mismatched destination bytes without overwriting or publishing', async () => {
  const f = await fixture(); f.api.putRestoredObject.mockImplementationOnce(async (_account, _sourceBucket, bucket, key) => { f.buckets.get(bucket)!.set(key, new Uint8Array([42])); });
  await expect(f.run()).rejects.toThrow('differs from the backup');
  const calls = f.api.putRestoredObject.mock.calls.length;
  await expect(f.run()).rejects.toThrow('differs from the backup');
  expect(f.api.putRestoredObject).toHaveBeenCalledTimes(calls); expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
});

it('blocks publication when unrelated credentials appear in the destination', async () => {
  const f = await fixture(); f.interrupt(sql => { if (sql.includes('UPDATE maintenance_state SET value=')) f.databases.get(destination)!.exec("INSERT OR IGNORE INTO auth_tokens(id,token_hash) VALUES('unexpected','hash')"); });
  await expect(f.run()).rejects.toThrow('Unexpected data in restored auth_tokens');
  expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
});

it('saves the destination across normalization and rejects source reuse or changed builds', async () => {
  const f = await fixture();
  expect(normalizeCrateSettings({ cloudflareRestore: f.state }, '.obsidian').cloudflareRestore).toEqual(f.state);
  f.state.target.d1DatabaseId = source.database;
  await expect(f.run()).rejects.toThrow('Restore state');
  f.state.target.d1DatabaseId = null; f.state.fingerprint = '0'.repeat(64);
  await expect(f.run()).rejects.toThrow('original build');
  expect(f.api.createD1Database).not.toHaveBeenCalled();
});

it('stops at uncertain publication and resumes through deployment verification', async () => {
  const f = await fixture(); vi.mocked(recoverDeployment).mockResolvedValueOnce({ status: 'blocked', message: 'Upload uncertain', diagnostics: '' });
  await expect(f.run()).rejects.toThrow('Upload uncertain'); expect(f.state.phase).toBe('publishing');
  const count = f.api.putRestoredObject.mock.calls.length;
  vi.mocked(recoverDeployment).mockResolvedValueOnce({ status: 'verify', resumeValue: 'confirmed', message: '', diagnostics: '' });
  await f.run();
  expect(completePublishedDeployment).toHaveBeenCalledOnce(); expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
  expect(f.api.putRestoredObject).toHaveBeenCalledTimes(count);
});

it('does not execute backup expressions and rejects unrecognized schemas', async () => {
  expect(() => parseBackupRows('INSERT INTO "files" ("path") VALUES (readfile(\'/etc/passwd\'));')).toThrow('Non-literal');
  expect(() => parseBackupRows('DROP TABLE files;')).toThrow('Unsupported');
  const f = await fixture();
  await f.rewriteSQL(sql => sql.replace(`VALUES (1,${SERVER_RELEASE.schemaVersion},${SERVER_RELEASE.schemaVersion})`, 'VALUES (1,99,99)'));
  await expect(f.run()).rejects.toThrow(); expect(f.api.createD1Database).not.toHaveBeenCalled();
});

it('pins the completed manifest and rejects a backup for another source', async () => {
  const f = await fixture();
  await expect(readBackup(f.client, { ...source, database: destination }, f.choice.prefix)).rejects.toThrow('different server');
  f.state.archiveHash = '0'.repeat(64);
  await expect(f.run()).rejects.toThrow('selected backup changed'); expect(f.api.createD1Database).not.toHaveBeenCalled();
});

it('guards every imported row against replay after a batch advances', () => {
  const db = database(); db.exec(schema); db.exec("INSERT INTO maintenance_state(key,value) VALUES('crate_restore_progress','plan:0')");
  const sql = rowSql({ table: 'reminder_identities', columns: ['reminder_id','created_operation_id'], values: ['id','op'] }, 'plan:0');
  db.exec(sql); db.exec("UPDATE maintenance_state SET value='plan:1'"); db.exec(sql);
  expect(db.prepare('SELECT COUNT(*) AS n FROM reminder_identities').get()).toEqual({ n: 1 });
});

it('resumes multiple batches from a later checkpoint without missing or duplicating rows', async () => {
  const f = await fixture(130); let batches = 0;
  f.interrupt(sql => { if (sql.includes('UPDATE maintenance_state SET value=') && ++batches === 2) throw new Error('Later batch interrupted'); });
  await expect(f.run()).rejects.toThrow('Later batch interrupted');
  await f.run();
  expect(f.databases.get(destination)!.prepare('SELECT COUNT(*) AS n FROM reminder_identities').get()).toEqual({ n: 130 });
});
it('rejects oversized rows before creating resources and does not round unsafe integers', async () => {
  const f = await fixture();
  await f.rewriteSQL(sql => sql + `INSERT INTO "reminder_identities" ("reminder_id","created_operation_id") VALUES ('id','${'x'.repeat(71000)}');`);
  await expect(f.run()).rejects.toThrow('too large'); expect(f.api.createD1Database).not.toHaveBeenCalled();
  expect(() => parseBackupRows('INSERT INTO "sqlite_sequence" ("name","seq") VALUES (\'changelog\',9007199254740993);')).toThrow();
});


it('preserves queued schema-2 captures and their policy across a restore', async () => {
  const f = await fixture();
  await f.rewriteSQL(sql => sql + `INSERT INTO "reading_captures" ("id","generation","url_identity","note","attempts","available_at") VALUES ('pending','generation','https://example.com/article','queued note',2,123456789);`);
  await f.run();
  expect(f.databases.get(destination)!.prepare('SELECT * FROM reading_captures').all()).toEqual([
    { id: 'pending', generation: 'generation', url_identity: 'https://example.com/article', note: 'queued note', attempts: 2, available_at: 123456789 },
  ]);
  expect(f.databases.get(destination)!.prepare('SELECT generation FROM reading_policy').get()).toEqual({ generation: 'generation' });
});

it('rejects a retired schema-1 archive before allocating destination resources', async () => {
  const f = await fixture();
  await f.rewriteSQL(sql => sql.replace(`VALUES (1,${SERVER_RELEASE.schemaVersion},${SERVER_RELEASE.schemaVersion})`, 'VALUES (1,1,1)'));
  await expect(f.run()).rejects.toThrow('Unsupported database schema');
  expect(f.api.createD1Database).not.toHaveBeenCalled();
});

it('rejects a future restore target before allocating destination resources', async () => {
  const f = await fixture();
  const rows = parseBackupRows(new TextDecoder().decode(f.buckets.get(source.bucket)!.get(`${f.choice.prefix}/database.sql`)));
  const version = SERVER_RELEASE.schemaVersion;
  try {
    SERVER_RELEASE.schemaVersion = 3;
    expect(() => prepareRows(rows, f.choice.manifest, schema, f.state.restoredAt)).toThrow('newer in-app restore adapter');
    await expect(f.run()).rejects.toThrow('newer in-app restore adapter');
    expect(f.api.createD1Database).not.toHaveBeenCalled();
  } finally { SERVER_RELEASE.schemaVersion = version; }
});
