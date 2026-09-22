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
  db.prepare('INSERT INTO files(path,portable_path,hash,size,storage_key) VALUES (?,?,?,?,?)').run('note.md','note.md',digest,bytes.length,'existing-object');
  db.prepare('INSERT INTO auth_tokens(id,token_hash,scope) VALUES (?,?,?)').run('old-device','hashed-secret','vault');
  const objects = new Map<string, Uint8Array>([['existing-object', bytes]]);
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
  try {
    await createUpgradeCheckpoint({ api: api as unknown as CloudflareApiClient, accountId: 'account', databaseId: 'database', bucketName: 'bucket', fence });
    expect(() => db.exec("DELETE FROM files")).toThrow('upgrade in progress');
    const manifestKey = [...objects.keys()].find(key => key.endsWith('/archive.json'))!;
    const prefix = manifestKey.slice(0, -'/archive.json'.length);
    const manifest = JSON.parse(new TextDecoder().decode(objects.get(manifestKey))) as { complete: boolean; objects: Array<{ key: string; sha256: string }> };
    expect(manifest.complete).toBe(true); expect(manifest.objects).toMatchObject([{ key: 'existing-object', sha256: digest }]);
    const restored = new DatabaseSync(':memory:'); restored.exec(new TextDecoder().decode(objects.get(`${prefix}/database.sql`)));
    expect(restored.prepare('SELECT scope FROM auth_tokens').get()).toMatchObject({ scope: 'vault' });
    expect(restored.prepare('SELECT storage_key FROM files').get()).toMatchObject({ storage_key: 'existing-object' }); restored.close();
    db.exec(`BEGIN; ${removeUpgradeGuards('auth_tokens')} ${await migrationTransaction(SERVER_RELEASE.migrations[0]!)} ${upgradeGuards('auth_tokens')} COMMIT;`);
    expect(db.prepare('SELECT version FROM crate_schema').get()).toMatchObject({ version: 2 });
    expect(db.prepare('SELECT scope FROM auth_tokens').get()).toMatchObject({ scope: 'vault' });
    await releaseUpgradeGuards(api as unknown as CloudflareApiClient, 'account', 'database', fence);
    expect(() => db.exec("UPDATE auth_tokens SET device_name='Updated'")).not.toThrow();
  } finally { db.close(); }
});
