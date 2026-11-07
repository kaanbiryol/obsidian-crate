import { afterEach, expect, it, vi } from 'vitest';
import { inspectDeploymentDatabase, prepareDeploymentDatabase, UnupgradableServerError } from './database';
import * as upgrades from './database-upgrades';
import { DeploymentFence } from './fence';

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

it('sends a database below the support floor to server replacement before planning an upgrade', async () => {
	const floor = upgrades.SERVER_RELEASE.minimumSchemaVersion;
	const plan = vi.spyOn(upgrades, 'planDatabaseUpgrade');
	const api = { queryD1: vi.fn(async (_account: string, _database: string, sql: string) => [{
		results: sql.includes('sqlite_master') ? [{ name: 'crate_schema' }] : [{ version: floor, created_version: floor }],
	}]) };
	const artifacts = { version: '0.1.0', fingerprint: 'f'.repeat(64), workerBundle: '', workerBundleSha256: '', d1Schema: '', d1SchemaSha256: '' };
	upgrades.SERVER_RELEASE.minimumSchemaVersion = floor + 1;
	try {
		await expect(inspectDeploymentDatabase({ api, accountId: 'account', databaseId: 'database', artifacts })).rejects.toThrow(UnupgradableServerError);
	} finally {
		upgrades.SERVER_RELEASE.minimumSchemaVersion = floor;
	}
	expect(plan).not.toHaveBeenCalled();
	expect(api.queryD1.mock.calls.every(([, , sql]) => sql.startsWith('SELECT '))).toBe(true);
});
