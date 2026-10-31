import { Notice, Platform } from 'obsidian';
import type CratePlugin from './CratePlugin';
import { beginCloudflareOperation } from './cloudflare-operation-guard';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { startCloudflareDeployment } from './cloudflare-operations';
import { openConfirmationModal } from '../ui/confirmation-modal';
import { openCloudflareDeploymentModal } from '../ui/cloudflare/deployment-modal';
import { BackupPicker, RestoredServer } from '../ui/cloudflare/restore-ui';
import type { BackupChoice } from '../cloudflare/restore/archive';
import { workersDevOrigin } from '../cloudflare/deployment/worker-origin';
import { CloudflareReauthorizationRequired } from '../cloudflare/oauth/client';
import { DESKTOP_ONLY_SERVER_CHANGE } from '../cloudflare/deployment/server-changes';

const renewLoginMessage = 'Your Cloudflare login needs renewing. Select Reconnect under Account and devices, then resume the restore.';

export async function openServerRestore(plugin: CratePlugin, chooseAnother = false): Promise<void> {
	if (Platform.isMobile) {
		new Notice(DESKTOP_ONLY_SERVER_CHANGE);
		return;
	}
	const signal = beginCloudflareOperation(plugin, 'Wait for the current Cloudflare operation to finish.');
	if (!signal) return;
	const saved = plugin.settings.cloudflareRestore;
	if (saved?.phase === 'complete' && !chooseAnother) {
		const progress = openCloudflareDeploymentModal(plugin.app, 'update', plugin.getSettingsDocument(), signal);
		showCompleted(plugin, progress, workersDevOrigin(saved.target.workerName, saved.target.workersSubdomain!));
		return;
	}
	if (saved && saved.phase !== 'complete') { await runRestore(plugin, null); return; }
	const progress = openCloudflareDeploymentModal(plugin.app, 'update', plugin.getSettingsDocument(), signal);
	progress.setWorking('Finding server backups', 'Reading completed upgrade backups from your Cloudflare account…');
	try {
		const backups = await plugin.cloudflareDeploymentService.listRestoreBackups(operation => plugin.cloudflareSavedLogin.withAuthorization(operation));
		if (signal.aborted) return;
		progress.dismiss();
		new BackupPicker(plugin.app, backups, backup => { void confirmRestore(plugin, backup); }).open();
	} catch (error) {
		if (!signal.aborted) progress.fail('Could not list server backups', error instanceof CloudflareReauthorizationRequired
			? renewLoginMessage : 'Check your connection and Cloudflare login, then try again.', undefined,
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
		const url = await plugin.cloudflareDeploymentService.restoreBackup(operation => plugin.cloudflareSavedLogin.withAuthorization(operation), backup,
			message => { if (!signal.aborted) progress.setWorking('Restoring server backup', message); });
		if (signal.aborted) return;
		plugin.refreshSettingsTab();
		showCompleted(plugin, progress, url);
	} catch (error) {
		if (signal.aborted) return;
		plugin.refreshSettingsTab();
		progress.fail('Restore needs attention', error instanceof CloudflareReauthorizationRequired
			? renewLoginMessage : 'The original server and backup are kept. Resume to check the same restore destination; do not delete its resources.', undefined,
		{ technicalDetails: error instanceof Error ? error.message : 'Unknown error', action: { label: 'Resume restore', onClick: () => { void openServerRestore(plugin); } } });
	}
}

function showCompleted(plugin: CratePlugin, progress: ReturnType<typeof openCloudflareDeploymentModal>, url: string): void {
	progress.dismiss();
	new RestoredServer(plugin.app, url, {
		connect: () => { void startCloudflareDeployment(plugin, 'switch'); },
		restoreAnother: () => { void openServerRestore(plugin, true); },
	}).open();
}
