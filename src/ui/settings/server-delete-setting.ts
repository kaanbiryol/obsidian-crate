import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { startCloudflareDeployment } from '../../cloudflare/plugin-integration';
import { openConfirmationModal } from '../confirmation-modal';

export function renderServerDeleteSetting(containerEl: HTMLElement, plugin: CratePlugin): void {
    const saved = plugin.settings.cloudflareDeployment;
    if (!saved?.accountId || !saved.d1DatabaseId || (saved.reset && !saved.reset.deleteOnly)) return;
    const snapshot = JSON.stringify(saved);
    const deployment = JSON.parse(snapshot) as typeof saved;
    const label = deployment.reset?.deleteOnly ? 'Resume server deletion' : 'Delete server';
    new Setting(containerEl)
        .setName('Delete server')
        .setDesc('Permanently remove this Crate server and all its remote data without rebuilding. Local vault files are kept.')
        .addButton(button => button.setButtonText(label).setDestructive().onClick(async () => {
            button.setDisabled(true);
            try {
                const confirmed = await openConfirmationModal(plugin.app, {
                    title: label,
                    message: 'Permanently delete this Crate server and all its remote data?',
                    details: [
                        `Account: ${deployment.accountName ?? deployment.accountId} (${deployment.accountId})`,
                        `Worker: ${deployment.workerName}`,
                        `Database: ${deployment.d1DatabaseName} (${deployment.d1DatabaseId})`,
                        `File bucket: ${deployment.r2BucketName}`,
                        'The Worker, web app, remote files, retained versions, recovery history, database, reminders, device registrations, and push subscriptions will be removed.',
                        'Nothing is rebuilt. All devices lose access to this server. Your local files are kept.',
                        'Other Crate deployments and unrelated Cloudflare resources are kept.',
                    ],
                    confirmText: 'Authorize server deletion',
                    warning: true,
                });
                if (!confirmed) return;
                if (JSON.stringify(plugin.settings.cloudflareDeployment) !== snapshot) {
                    new Notice('Server settings changed. Open the deletion confirmation again.');
                    return;
                }
                await startCloudflareDeployment(plugin, 'delete');
            } finally {
                button.setDisabled(false);
            }
        }));
}
