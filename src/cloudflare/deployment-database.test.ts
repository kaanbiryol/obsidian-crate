import { afterEach, expect, it, vi } from 'vitest';
import { prepareDeploymentDatabase } from './deployment-database';
import * as upgrades from './database-upgrades';
import { DeploymentFence } from './deployment-fence';

afterEach(() => vi.restoreAllMocks());

it('refuses a future data migration before executing SQL without a verified checkpoint workflow', async () => {
  vi.spyOn(upgrades, 'planDatabaseUpgrade').mockReturnValue([{ id: 'example', from: 1, to: 2, file: 'example.sql', checksum: 'a'.repeat(64) }]);
  const api = { queryD1: vi.fn(async () => []) };
  const artifacts = { version: '0.1.0', fingerprint: 'f'.repeat(64), workerBundle: '', workerBundleSha256: '', d1Schema: '', d1SchemaSha256: '' };
  const fence = new DeploymentFence(api, 'account', 'database', '{}');
  await expect(prepareDeploymentDatabase({ api, accountId: 'account', databaseId: 'database', artifacts }, 1, fence)).rejects.toThrow('verified recovery checkpoint');
  expect(api.queryD1).not.toHaveBeenCalled();
  const backup = vi.fn(async () => { throw new Error('archive verification failed'); });
  await expect(prepareDeploymentDatabase({ api, accountId: 'account', databaseId: 'database', artifacts }, 1, fence, backup)).rejects.toThrow('archive verification failed');
  expect(backup).toHaveBeenCalledOnce();
  expect(api.queryD1).not.toHaveBeenCalled();
});
