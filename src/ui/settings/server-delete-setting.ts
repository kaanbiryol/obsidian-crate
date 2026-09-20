import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { startCloudflareDeployment } from '../../cloudflare/plugin-integration';
import { openConfirmationModal } from '../confirmation-modal';

export function renderServerDeleteSetting(containerEl: HTMLElement, plugin: CratePlugin): void {
    const saved = plugin.settings.cloudflareDeployment;
    if (!saved?.accountId || !saved.d1DatabaseId || (saved.reset && !saved.reset.deleteOnly)) return;
    const snapshot = JSON.stringify(saved);
    const deployment = JSON.parse(snapshot) as typeof saved;
    const label = deployment.reset?.deleteOnly ? 'Resume server deletion' : 'Delete server and all data';
    new Setting(containerEl)
        .setName('Delete server and all data')
        .setDesc(deployment.reset?.deleteOnly
            ? 'Check the interrupted deletion and continue removing this server. Local vault files are kept.'
            : 'Permanently delete the server and its remote data for all devices. Local vault files are kept.')
        .addButton(button => button.setButtonText(label).setDestructive().onClick(async () => {
            button.setDisabled(true);
            try {
                const confirmed = await openConfirmationModal(plugin.app, {
                    title: label,
                    message: 'Permanently delete this Crate server and all its remote data?',
                    details: [
                        'All devices will lose access. Deleted server data cannot be recovered.',
                        'Your local vault files are kept. Other Crate servers and unrelated Cloudflare resources are kept.',
                        'This removes the web app, remote files and versions, recovery history, reminders, and device registrations with their push subscriptions.',
                        `Account: ${deployment.accountName ? `${deployment.accountName} (${deployment.accountId})` : deployment.accountId}`,
                        `Worker: ${deployment.workerName}`,
                        `Database: ${deployment.d1DatabaseName} (${deployment.d1DatabaseId})`,
                        `File bucket: ${deployment.r2BucketName}`,
                        'To sync again, connect with Cloudflare, create a new server, then run Crate: Sync now.',
                    ],
                    confirmText: 'Delete server',
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
