import { beforeEach, expect, it, vi } from 'vitest';
import { FakeElement, MockModal, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';
import type CratePlugin from '../../plugin/CratePlugin';
import type { BackupChoice } from './archive';
const { progress, confirm, connect } = vi.hoisted(() => ({ progress: { dismiss: vi.fn(), setWorking: vi.fn(), fail: vi.fn() }, confirm: vi.fn(), connect: vi.fn() }));
vi.mock('obsidian', () => createObsidianUiModule());
vi.mock('../../ui/plugin/SharedModal', () => ({ SharedModal: class extends MockModal { bodyEl = new FakeElement('div'); openLayout() {} } }));
vi.mock('../../ui/cloudflare-deployment-modal', () => ({ openCloudflareDeploymentModal: () => progress, revealCloudflareOperation: () => false }));
vi.mock('../../ui/confirmation-modal', () => ({ openConfirmationModal: confirm }));
vi.mock('../plugin-integration', () => ({ startCloudflareDeployment: connect }));
vi.mock('../../plugin/lifecycle-state', () => ({ getPluginLifecycleSignal: () => new AbortController().signal }));
import { openServerRestore } from './ui';
import { CloudflareReauthorizationRequired } from '../oauth-client';
const backup = { prefix: 'backup', hash: 'hash', manifest: { createdAt: '2026-09-01T00:00:00Z', objects: [] } } as unknown as BackupChoice;
function harness(saved?: unknown) {
  const plugin = { app: {}, settings: { cloudflareRestore: saved }, getSettingsDocument: vi.fn(), refreshSettingsTab: vi.fn(), cloudflareUsageConnection: { withAuthorization: vi.fn() }, cloudflareDeploymentService: { isBusy: false, listRestoreBackups: vi.fn(async () => [backup]), restoreBackup: vi.fn(async () => 'https://restored.test.workers.dev') } };
  return { plugin, open: () => openServerRestore(plugin as unknown as CratePlugin) };
}
beforeEach(() => { resetObsidianUiMocks(); vi.clearAllMocks(); });
it('dismisses progress before showing backups and only restores after confirmation', async () => {
  const f = harness(); confirm.mockResolvedValue(true);
  await f.open(); expect(progress.dismiss).toHaveBeenCalledOnce();
  expect(f.plugin.cloudflareDeploymentService.restoreBackup).not.toHaveBeenCalled();
  MockSetting.instances.find(setting => setting.buttons[0]?.buttonEl.textContent === 'Restore…')!.buttons[0]!.click();
  await vi.waitFor(() => expect(f.plugin.cloudflareDeploymentService.restoreBackup).toHaveBeenCalledOnce());
  expect(confirm).toHaveBeenCalledWith(f.plugin.app, expect.objectContaining({ title: 'Restore into a separate server' }));
  expect(connect).not.toHaveBeenCalled();
  expect(MockSetting.instances.some(setting => setting.nameEl.textContent === 'Connect to the restored server')).toBe(true);
});
it('does not restore when confirmation is cancelled', async () => {
  const f = harness(); confirm.mockResolvedValue(false); await f.open();
  MockSetting.instances[0]!.buttons[0]!.click(); await Promise.resolve(); await Promise.resolve();
  expect(f.plugin.cloudflareDeploymentService.restoreBackup).not.toHaveBeenCalled();
});
it('reviews a completed restore locally and allows another backup selection', async () => {
  const f = harness({ phase: 'complete', target: { workerName: 'crate-restored', workersSubdomain: 'test' } });
  await f.open();
  expect(f.plugin.cloudflareDeploymentService.restoreBackup).not.toHaveBeenCalled();
  MockSetting.instances.find(setting => setting.nameEl.textContent === 'Restore another backup')!.buttons[0]!.click();
  await vi.waitFor(() => expect(f.plugin.cloudflareDeploymentService.listRestoreBackups).toHaveBeenCalledOnce());
});
it('resumes the saved restore without selecting another backup', async () => {
  const f = harness({ phase: 'copying' }); await f.open();
  expect(f.plugin.cloudflareDeploymentService.listRestoreBackups).not.toHaveBeenCalled();
  expect(f.plugin.cloudflareDeploymentService.restoreBackup).toHaveBeenCalledWith(expect.any(Function), null, expect.any(Function));
});

it.each(['list', 'resume'])('explains a denied saved login during %s', async mode => {
  const f = harness(mode === 'resume' ? { phase: 'copying' } : undefined);
  f.plugin.cloudflareDeploymentService.listRestoreBackups.mockRejectedValue(new CloudflareReauthorizationRequired());
  f.plugin.cloudflareDeploymentService.restoreBackup.mockRejectedValue(new CloudflareReauthorizationRequired());
  await f.open();
  expect(progress.fail).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('login needs renewing'), undefined, expect.any(Object));
});
