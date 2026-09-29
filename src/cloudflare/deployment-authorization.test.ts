import { expect, it, vi } from 'vitest';
import { CloudflareDeploymentService } from './deployment-service';
import { CloudflareUsageConnection } from './usage-connection';
import { CloudflareReauthorizationRequired } from './oauth-client';
import { CLOUDFLARE_OAUTH_SCOPES } from './oauth-config';
import { DEFAULT_SETTINGS } from '../plugin/settings';
import type { HttpTransport } from './http';
import type { BackupChoice } from './restore/archive';

function harness(status: number, scope = CLOUDFLARE_OAUTH_SCOPES.join(' ')) {
  const name = `crate-${'a'.repeat(16)}`;
  const settings = { ...DEFAULT_SETTINGS, cloudflareDeployment: { deploymentId: 'a'.repeat(16), accountId: 'a'.repeat(32), accountName: 'Account',
    workerName: name, d1DatabaseName: name, d1DatabaseId: '11111111-1111-1111-1111-111111111111', r2BucketName: name,
    workersSubdomain: 'test', lastDeployedVersion: null, lastDeployedFingerprint: null } };
  const transport = vi.fn<HttpTransport>(async () => ({ status, text: JSON.stringify({ success: false, errors: [{ message: 'Denied' }] }) }));
  const secrets = new Map<string, string>();
  const connection = new CloudflareUsageConnection({ clientId: 'client', transport, signal: new AbortController().signal,
    accountId: () => settings.cloudflareDeployment.accountId, openExternal: vi.fn(),
    secrets: { get: key => secrets.get(key), set: (key, value) => { secrets.set(key, value); } } });
  connection.acceptAuthorization(settings.cloudflareDeployment.accountId, { accessToken: 'synthetic', expiresIn: 3600, scope });
  const service = new CloudflareDeploymentService({ clientId: 'client', settingsOwner: { settings, writeSettings: async update => { Object.assign(settings, update); } },
    transport, loadArtifacts: async () => ({ version: '0.4.0', fingerprint: 'f'.repeat(64), workerBundle: '', workerBundleSha256: '', d1Schema: '', d1SchemaSha256: '' }),
    openExternal: vi.fn(), selectDeployment: async () => null });
  const choice: BackupChoice = { prefix: `__crate__/backups/schema-upgrade-${settings.cloudflareDeployment.d1DatabaseId}`, hash: 'b'.repeat(64),
    manifest: { format: 1, complete: true, createdAt: new Date().toISOString(), source: { account: settings.cloudflareDeployment.accountId, database: settings.cloudflareDeployment.d1DatabaseId, bucket: name }, databaseSha256: 'c'.repeat(64), objects: [] } };
  const authorize: Parameters<typeof service.recoverUpdate>[0] = operation => connection.withAuthorization(operation);
  return { connection, service, transport, operations: {
    update: () => service.deployWithSavedAuthorization('update', authorize),
    recover: () => service.recoverUpdate(authorize),
    list: () => service.listRestoreBackups(authorize),
    restore: () => service.restoreBackup(authorize, choice, vi.fn()),
  } };
}

it.each(['update', 'recover', 'list', 'restore'] as const)('marks saved %s credentials for renewal on both denied statuses', async operation => {
  for (const status of [401, 403]) {
    const f = harness(status);
    await expect(f.operations[operation]()).rejects.toBeInstanceOf(CloudflareReauthorizationRequired);
    expect(f.connection.needsAuthorization).toBe(true);
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.service.isBusy).toBe(false);
  }
});

it.each(['update', 'recover', 'list', 'restore'] as const)('checks management scope before %s performs remote work', async operation => {
  const f = harness(200, 'account-analytics.read');
  await expect(f.operations[operation]()).rejects.toBeInstanceOf(CloudflareReauthorizationRequired);
  expect(f.connection.needsAuthorization).toBe(true);
  expect(f.transport).not.toHaveBeenCalled();
  expect(f.service.isBusy).toBe(false);
});

it.each(['update', 'recover', 'list', 'restore'] as const)('does not misclassify a %s server failure as expired consent', async operation => {
  const f = harness(503);
  await expect(f.operations[operation]()).rejects.not.toBeInstanceOf(CloudflareReauthorizationRequired);
  expect(f.connection.needsAuthorization).toBe(false);
  expect(f.service.isBusy).toBe(false);
});
