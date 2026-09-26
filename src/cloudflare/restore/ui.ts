import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { SharedModal } from '../../ui/shared/SharedModal';
import { openConfirmationModal } from '../../ui/confirmation-modal';
import { openCloudflareDeploymentModal, revealCloudflareOperation } from '../../ui/cloudflare-deployment-modal';
import { getPluginLifecycleSignal } from '../../plugin/lifecycle-state';
import { startCloudflareDeployment } from '../plugin-integration';
import type { BackupChoice } from './archive';

class BackupPicker extends SharedModal {
  constructor(plugin: CratePlugin, private readonly backups: BackupChoice[], private readonly select: (backup: BackupChoice) => void) { super(plugin.app); }
  onOpen(): void {
    this.openLayout('Restore server backup');
    this.bodyEl.createEl('p', { text: 'Choose the server backup to restore. Crate will verify it and create a separate server with its files and history. Your current server and local vault are kept.' });
    if (!this.backups.length) this.bodyEl.createEl('p', { text: 'No completed upgrade backups were found for this server.' });
    for (const backup of this.backups) {
      const size = backup.manifest.objects.reduce((total, item) => total + item.size, 0);
      new Setting(this.bodyEl).setName(new Date(backup.manifest.createdAt).toLocaleString())
        .setDesc(`${backup.manifest.objects.length.toLocaleString()} files and versions · ${(size / 1024 / 1024).toFixed(1)} MB`)
        .addButton(button => button.setButtonText('Restore…').onClick(() => { this.close(); this.select(backup); }));
    }
  }
}
export async function openServerRestore(plugin: CratePlugin, chooseAnother = false): Promise<void> {
  const signal = getPluginLifecycleSignal(plugin);
  if (signal.aborted || revealCloudflareOperation(plugin.app, plugin.getSettingsDocument())) return;
  if (plugin.cloudflareDeploymentService.isBusy) { new Notice('Wait for the current Cloudflare operation to finish.'); return; }
  const saved = plugin.settings.cloudflareRestore;
  if (saved?.phase === 'complete' && !chooseAnother) {
    const progress = openCloudflareDeploymentModal(plugin.app, 'update', plugin.getSettingsDocument(), signal);
    showCompleted(plugin, progress, `https://${saved.target.workerName}.${saved.target.workersSubdomain}.workers.dev`);
    return;
  }
  if (saved && saved.phase !== 'complete') { await runRestore(plugin, null); return; }
  const progress = openCloudflareDeploymentModal(plugin.app, 'update', plugin.getSettingsDocument(), signal);
  progress.setWorking('Finding server backups', 'Reading completed upgrade backups from your Cloudflare account…');
  try {
    const backups = await plugin.cloudflareDeploymentService.listRestoreBackups(operation => plugin.cloudflareUsageConnection.withAuthorization(operation));
    if (signal.aborted) return;
    progress.dismiss();
    new BackupPicker(plugin, backups, backup => { void confirmRestore(plugin, backup); }).open();
  } catch (error) {
    if (!signal.aborted) progress.fail('Could not list server backups', 'Check your connection and Cloudflare login, then try again.', undefined,
      { technicalDetails: error instanceof Error ? error.message : 'Unknown error' });
  }
}
async function confirmRestore(plugin: CratePlugin, backup: BackupChoice): Promise<void> {
  if (!await openConfirmationModal(plugin.app, {
    title: 'Restore into a separate server', message: `Restore the backup from ${new Date(backup.manifest.createdAt).toLocaleString()}?`,
    details: ['The restored server uses additional Cloudflare storage. Your current server and backup are retained.',
      'Changes made after this backup are not included. Devices must be connected again after you review the restored server. Your local vault will not be changed by this restore.'],
    confirmText: 'Restore backup',
  })) return;
  await runRestore(plugin, backup);
}
async function runRestore(plugin: CratePlugin, backup: BackupChoice | null): Promise<void> {
  const signal = getPluginLifecycleSignal(plugin);
  if (signal.aborted) return;
  const progress = openCloudflareDeploymentModal(plugin.app, 'update', plugin.getSettingsDocument(), signal);
  progress.setWorking('Restoring server backup', 'Verifying the backup. Keep Obsidian open until the restore finishes.');
  try {
    const url = await plugin.cloudflareDeploymentService.restoreBackup(operation => plugin.cloudflareUsageConnection.withAuthorization(operation), backup,
      message => { if (!signal.aborted) progress.setWorking('Restoring server backup', message); });
    if (signal.aborted) return;
    plugin.refreshSettingsTab();
    showCompleted(plugin, progress, url);
  } catch (error) {
    if (signal.aborted) return;
    plugin.refreshSettingsTab();
    progress.fail('Restore needs attention', 'The original server and backup are kept. Resume to check the same restore destination; do not delete its resources.', undefined,
      { technicalDetails: error instanceof Error ? error.message : 'Unknown error', action: { label: 'Resume restore', onClick: () => { void openServerRestore(plugin); } } });
  }
}

class RestoredServer extends SharedModal {
  constructor(private readonly plugin: CratePlugin, private readonly url: string) { super(plugin.app); }
  onOpen(): void {
    this.openLayout('Backup restored');
    this.bodyEl.createEl('p', { text: `Your separate server is ready: ${this.url}` });
    this.bodyEl.createEl('p', { text: 'Back up your local vault before connecting, then select the server marked “restored”. Devices need to be connected again.' });
    new Setting(this.bodyEl).setName('Connect to the restored server')
      .addButton(button => button.setButtonText('Choose server…').onClick(() => { this.close(); void startCloudflareDeployment(this.plugin, 'switch'); }));
    new Setting(this.bodyEl).setName('Restore another backup')
      .setDesc('Create another separate server from a different backup.')
      .addButton(button => button.setButtonText('Choose backup…').onClick(() => { this.close(); void openServerRestore(this.plugin, true); }));
  }
}
function showCompleted(plugin: CratePlugin, progress: ReturnType<typeof openCloudflareDeploymentModal>, url: string): void {
  progress.dismiss();
  new RestoredServer(plugin, url).open();
}
