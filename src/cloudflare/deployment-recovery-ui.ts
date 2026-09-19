import { Notice } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { openCloudflareDeploymentModal, revealCloudflareOperation } from '../ui/cloudflare-deployment-modal';
import { startCloudflareDeployment } from './plugin-integration';
import { CloudflareReauthorizationRequired } from './oauth-client';
import { DeploymentRecoveryRequiredError } from './deployment-fence';

export async function checkAndRecoverUpdate(plugin: CratePlugin): Promise<void> {
    const signal = getPluginLifecycleSignal(plugin);
    if (signal.aborted) return;
    if (revealCloudflareOperation(plugin.app, plugin.getSettingsDocument())) return;
    if (plugin.cloudflareDeploymentService.isBusy) {
        new Notice('A Cloudflare operation is still running. Wait for its result before checking recovery.');
        return;
    }
    const progress = openCloudflareDeploymentModal(plugin.app, 'update', plugin.getSettingsDocument(), signal);
    progress.setWorking('Checking server update', 'Checking Cloudflare and the interrupted operation. Keep Obsidian open until this check finishes.');
    try {
        const result = await plugin.cloudflareDeploymentService.recoverUpdate(
            operation => plugin.cloudflareUsageConnection.withAuthorization(operation),
        );
        if (signal.aborted) return;
        plugin.refreshSettingsTab();
        if (result.status === 'blocked') {
            progress.fail('Server update needs review', result.message, [
                'If another device is updating this server, let it finish and check again.',
                'If the operation was interrupted, share these diagnostics with whoever supports your Crate server.',
            ], {
                technicalDetails: result.diagnostics,
                action: { label: 'Copy diagnostics', onClick: () => {
                    void navigator.clipboard.writeText(result.diagnostics)
                        .then(() => { new Notice('Recovery diagnostics copied'); })
                        .catch(() => { new Notice('Could not copy diagnostics. Select the technical details and copy them manually.'); });
                } },
            });
        } else if (result.status === 'completed') {
            progress.succeed('Server updated', result.message);
        } else {
            progress.succeed('Server update checked', result.message, {
                action: { label: 'Update server', onClick: () => { void startCloudflareDeployment(plugin, 'update'); } },
            });
        }
    } catch (error) {
        if (signal.aborted) return;
        progress.fail('Could not check the server', error instanceof CloudflareReauthorizationRequired
            ? 'Your Cloudflare login needs renewing. Reconnect your Cloudflare account in settings, then select Check and recover update again.'
            : error instanceof DeploymentRecoveryRequiredError
            ? 'The published update could not be verified. Its lock remains held. Review the technical details before checking again.'
            : 'The check could not finish. Reconnect to the network and check again. If a recovery request reached Cloudflare, the next check will inspect its result.',
        undefined, { technicalDetails: error instanceof Error ? error.message : 'Unknown recovery error' });
    }
}
