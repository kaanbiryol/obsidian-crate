import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createUpgradeCheckpoint, releaseUpgradeGuards, removeUpgradeGuards, upgradeGuards } from './upgrade-checkpoint';
import { migrationTransaction, SERVER_RELEASE } from './database-upgrades';
import { sha256Hex } from './deployment-artifacts';
import type { CloudflareApiClient } from './cloudflare-api';
import type { DeploymentFence } from './deployment-fence';

it('freezes old writers, verifies paired bytes, migrates atomically and restores an independently readable archive', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync('src/cloudflare/migrations/schema-v1.sql', 'utf8'));
  const bytes = new TextEncoder().encode('Existing note.'); const digest = await sha256Hex('Existing note.');
  const historyBytes = new TextEncoder().encode('Earlier note.'); const historyDigest = await sha256Hex('Earlier note.');
  db.prepare('INSERT INTO files(path,portable_path,hash,size,storage_key) VALUES (?,?,?,?,?)').run('note.md','note.md',digest,bytes.length,'existing-object');
  db.prepare('INSERT INTO file_versions(storage_key,path,hash,size,reason,expires_at) VALUES (?,?,?,?,?,?)').run('historical-object','note.md',historyDigest,historyBytes.length,'replaced',2_000_000_000);
  db.prepare('INSERT INTO auth_tokens(id,token_hash,scope) VALUES (?,?,?)').run('old-device','hashed-secret','vault');
  const objects = new Map<string, Uint8Array>([['existing-object', bytes], ['historical-object', historyBytes]]);
  const api = {
    queryD1: vi.fn(async (_account: string, _database: string, sql: string, params: string[] = []) => {
      if (sql.trim().startsWith('SELECT')) return [{ results: db.prepare(sql).all(...params) }];
      if (params.length) db.prepare(sql).run(...params); else db.exec(sql);
      return [{ results: [] }];
    }),
    getRecoveryObject: vi.fn(async (_account: string, _bucket: string, key: string) => { const value = objects.get(key); if (!value) throw new Error('Recovery object unavailable (404)'); return value; }),
    putRecoveryObject: vi.fn(async (_account: string, _bucket: string, key: string, value: Uint8Array) => { objects.set(key, value); }),
  };
  const fence = { requireVerification: vi.fn(), mutate: <T>(fn: () => Promise<T>) => fn() } as unknown as DeploymentFence;
  const onProgress = vi.fn<(message: string) => void>();
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  try {
    await createUpgradeCheckpoint({ api: api as unknown as CloudflareApiClient, accountId: 'account', databaseId: 'database', bucketName: 'bucket', fence, onProgress });
    expect(onProgress.mock.calls.map(([message]) => message)).toEqual([
      'Backing up the server database. Large servers can take several minutes…',
      'Counting files and history for the backup…',
      'Backing up files and history: 0 of 2 verified. This may take several minutes…',
      'Backing up files and history: 2 of 2 verified. This may take several minutes…',
      'Finishing and verifying the backup archive…',
    ]);
    expect(() => db.exec("DELETE FROM files")).toThrow('upgrade in progress');
    const manifestKey = [...objects.keys()].find(key => key.endsWith('/archive.json'))!;
    const prefix = manifestKey.slice(0, -'/archive.json'.length);
    const manifest = JSON.parse(new TextDecoder().decode(objects.get(manifestKey))) as { complete: boolean; objects: Array<{ key: string; sha256: string }> };
    expect(manifest.complete).toBe(true);
    expect(manifest.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'existing-object', sha256: digest }),
      expect.objectContaining({ key: 'historical-object', sha256: historyDigest }),
    ]));
    const restored = new DatabaseSync(':memory:'); restored.exec(new TextDecoder().decode(objects.get(`${prefix}/database.sql`)));
    expect(restored.prepare('SELECT scope FROM auth_tokens').get()).toMatchObject({ scope: 'vault' });
    expect(restored.prepare('SELECT storage_key FROM files').get()).toMatchObject({ storage_key: 'existing-object' }); restored.close();
    db.exec(`BEGIN; ${removeUpgradeGuards('auth_tokens')} ${await migrationTransaction(SERVER_RELEASE.migrations[0]!)} ${upgradeGuards('auth_tokens')} COMMIT;`);
    expect(db.prepare('SELECT version FROM crate_schema').get()).toMatchObject({ version: 2 });
    expect(db.prepare('SELECT scope FROM auth_tokens').get()).toMatchObject({ scope: 'vault' });
    await releaseUpgradeGuards(api as unknown as CloudflareApiClient, 'account', 'database', fence);
    expect(() => db.exec("UPDATE auth_tokens SET device_name='Updated'")).not.toThrow();
  } finally { now.mockRestore(); db.close(); }
});
