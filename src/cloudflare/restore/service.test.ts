import { beforeEach, expect, it, vi } from 'vitest';
import { CloudflareDeploymentService } from '../deployment/service';
import { DEFAULT_SETTINGS, type CrateSettings } from '../../plugin/settings';
import type { CloudflareOAuthTokens } from '../oauth/client';
import { listUpgradeBackups, restoreUpgradeBackup } from './server-restore';
import type { BackupChoice } from './archive';
import type { HttpTransport } from '../http';
vi.mock('./server-restore', () => ({ listUpgradeBackups: vi.fn(), restoreUpgradeBackup: vi.fn() }));
const authorize = <T>(operation: (tokens: CloudflareOAuthTokens) => Promise<T>) => operation({ accessToken: 'private' });
function harness() {
  const settings: CrateSettings = { ...DEFAULT_SETTINGS, cloudflareDeployment: { deploymentId: 'a'.repeat(16), accountId: 'a'.repeat(32), accountName: 'Account', workerName: `crate-${'a'.repeat(16)}`, d1DatabaseName: `crate-${'a'.repeat(16)}`, d1DatabaseId: '11111111-1111-1111-1111-111111111111', r2BucketName: `crate-${'a'.repeat(16)}`, workersSubdomain: 'test', lastDeployedVersion: null, lastDeployedFingerprint: null } };
  const writeSettings = vi.fn(async (update: Partial<CrateSettings>) => { Object.assign(settings, update); });
  const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify({ success: true, result: [] }) }));
  const service = new CloudflareDeploymentService({ clientId: 'a'.repeat(32), settingsOwner: { settings, writeSettings }, transport, loadArtifacts: async () => ({ version: '0.3.0', fingerprint: 'f'.repeat(64), workerBundle: '', workerBundleSha256: '', d1Schema: '', d1SchemaSha256: '' }), openExternal: vi.fn() });
  const choice: BackupChoice = { prefix: '__crate__/backups/schema-upgrade-11111111-1111-1111-1111-111111111111', hash: 'b'.repeat(64), manifest: { format: 1, complete: true, createdAt: new Date().toISOString(), source: { account: settings.cloudflareDeployment!.accountId!, database: settings.cloudflareDeployment!.d1DatabaseId!, bucket: settings.cloudflareDeployment!.r2BucketName }, databaseSha256: 'c'.repeat(64), objects: [] } };
  return { settings, writeSettings, transport, service, choice };
}
beforeEach(() => vi.resetAllMocks());
it('persists the restore identity before remote work and preserves the current connection', async () => {
  const f = harness(), source = structuredClone(f.settings.cloudflareDeployment);
  vi.mocked(restoreUpgradeBackup).mockImplementation(async input => {
    expect(f.settings.cloudflareRestore).toEqual(input.state);
    expect(input.state.target.workerName).not.toBe(source!.workerName);
    expect(input.state.target.workerName).toMatch(/^crate-[a-f0-9]{16}$/);
    input.state.phase = 'publishing'; await input.save(); throw new Error('Interrupted');
  });
  await expect(f.service.restoreBackup(authorize, f.choice, vi.fn())).rejects.toThrow('Interrupted');
  const checkpoint = structuredClone(f.settings.cloudflareRestore);
  vi.mocked(restoreUpgradeBackup).mockImplementation(async input => { expect(input.state).toEqual(checkpoint); return 'restored'; });
  await f.service.restoreBackup(authorize, null, vi.fn());
  expect(f.settings.cloudflareDeployment).toEqual(source);
  expect(f.writeSettings.mock.calls.every(([update]) => Object.keys(update).join() === 'cloudflareRestore')).toBe(true);
});
it.each([
  ['copying', false], ['copying', true],
  ['publishing', false], ['publishing', true],
  ['complete', false], ['complete', true],
] as const)('selects the checkpoint after %s with an explicit choice: %s', async (phase, chooseAnother) => {
  const f = harness();
  vi.mocked(restoreUpgradeBackup).mockImplementationOnce(async input => {
    input.state.phase = phase;
    input.state.target.d1DatabaseId = '22222222-2222-2222-2222-222222222222';
    await input.save();
    return 'restored';
  });
  await f.service.restoreBackup(authorize, f.choice, vi.fn());
  const checkpoint = structuredClone(f.settings.cloudflareRestore);
  const choice = chooseAnother ? {
    ...f.choice, prefix: '__crate__/backups/schema-upgrade-33333333-3333-3333-3333-333333333333', hash: 'd'.repeat(64),
  } : null;
  vi.mocked(restoreUpgradeBackup).mockImplementationOnce(async input => {
    expect(f.settings.cloudflareRestore).toEqual(input.state);
    if (phase === 'complete' && choice) {
      expect(input.state.id).not.toBe(checkpoint!.id);
      expect(input.state).toMatchObject({ phase: 'copying', prefix: choice.prefix, archiveHash: choice.hash });
      expect(input.state.target.d1DatabaseId).toBeNull();
    } else expect(input.state).toEqual(checkpoint);
    return 'restored';
  });
  await f.service.restoreBackup(authorize, choice, vi.fn());
});
it('does not start remote restore when the initial checkpoint cannot be saved', async () => {
  const f = harness();
  f.writeSettings.mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(f.service.restoreBackup(authorize, f.choice, vi.fn())).rejects.toThrow('Storage unavailable');
  expect(restoreUpgradeBackup).not.toHaveBeenCalled();
  expect(f.settings.cloudflareRestore).toBeUndefined();
  expect(f.service.isBusy).toBe(false);
});
it('does not replace a checkpoint belonging to another source server', async () => {
  const f = harness();
  vi.mocked(restoreUpgradeBackup).mockResolvedValueOnce('restored');
  await f.service.restoreBackup(authorize, f.choice, vi.fn());
  const checkpoint = structuredClone(f.settings.cloudflareRestore);
  f.settings.cloudflareDeployment!.d1DatabaseId = '22222222-2222-2222-2222-222222222222';
  f.writeSettings.mockClear();
  vi.mocked(restoreUpgradeBackup).mockClear();
  await expect(f.service.restoreBackup(authorize, null, vi.fn())).rejects.toThrow('original server');
  expect(f.writeSettings).not.toHaveBeenCalled();
  expect(restoreUpgradeBackup).not.toHaveBeenCalled();
  expect(f.settings.cloudflareRestore).toEqual(checkpoint);
  expect(f.service.isBusy).toBe(false);
});
it('holds the operation lock during authorization and releases it after failure', async () => {
  const f = harness(); let release!: () => void;
  const pending = f.service.listRestoreBackups(async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error('Login cancelled'); });
  expect(f.service.isBusy).toBe(true);
  await expect(f.service.startDeployment('switch')).rejects.toThrow('Wait');
  await expect(f.service.listRestoreBackups(authorize)).rejects.toThrow('Wait');
  release(); await expect(pending).rejects.toThrow('Login cancelled'); expect(f.service.isBusy).toBe(false);
});
it.each(['changed', 'destroyed'])('stops network work when the source is %s', async mode => {
  const f = harness();
  vi.mocked(listUpgradeBackups).mockImplementation(async (api, source) => {
    if (mode === 'destroyed') f.service.destroy(); else f.settings.cloudflareDeployment = null;
    await api.queryD1(source.account, source.database, 'SELECT 1'); return [];
  });
  await expect(f.service.listRestoreBackups(authorize)).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled(); expect(f.service.isBusy).toBe(false);
});
