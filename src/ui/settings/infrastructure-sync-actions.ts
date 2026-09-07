import { showSyncErrorNotice } from '../sync-error-notice';
import { Notice, Setting } from 'obsidian';
import { openConfirmationModal } from '../confirmation-modal';
import {
	createFileSyncProgress,
	hideFileSyncProgress,
	runButtonTask,
	showFileSyncProgress,
	updateFileSyncProgress,
} from './action-helpers';
import type { InfrastructureSectionContext } from './infrastructure-types';

export function renderInfrastructureSyncActions(context: InfrastructureSectionContext): void {
	const { containerEl, plugin, isConfigured, rerender } = context;

	if (!isConfigured) {
		return;
	}

	const initialSyncSetting = new Setting(containerEl)
		.setName('Initial sync')
		.setDesc('Upload all local files included in sync. Use this when setting up a new server.')
		.addButton(button => button
			.setButtonText('Upload all')
			.setDestructive()
			.onClick(async () => {
				const confirmed = await openConfirmationModal(plugin.app, {
					title: 'Upload all local files',
					message: 'Upload all local files in this vault to the sync server?',
					details: ['Use this for first-time setup on a new remote.'],
					confirmText: 'Upload all',
					warning: true,
				});
				if (!confirmed) {
					return;
				}

				await runButtonTask({
					button,
					idleText: 'Upload all',
					runningText: 'Uploading...',
					onStart: () => {
						showFileSyncProgress(initialProgress);
					},
					task: async ({ setButtonText }) => plugin.syncRuntime.initialSync((current, total) => {
						setButtonText(`Uploading... ${current}/${total}`);
						updateFileSyncProgress(initialProgress, current, total);
					}),
					onSuccess: (result) => {
						if (result.success) {
							new Notice(`Initial sync complete: ${result.uploaded} files uploaded`);
						} else {
							showSyncErrorNotice(plugin, 'Initial sync completed with errors.');
						}
					},
					onError: () => {
						new Notice('Initial sync failed');
					},
					onFinally: () => {
						hideFileSyncProgress(initialProgress);
						rerender();
					},
				});
			}));
	const initialProgress = createFileSyncProgress(initialSyncSetting);

	const forceSyncSetting = new Setting(containerEl)
		.setName('Force full sync')
		.setDesc('Replace the server copy of your vault with local files. Files found only on the server will be deleted.')
		.addButton(button => button
			.setButtonText('Force full update')
			.setDestructive()
			.onClick(async () => {
				const confirmed = await openConfirmationModal(plugin.app, {
					title: 'Force full sync',
					message: 'Overwrite the remote vault with local files?',
						details: [
							'Remote-only files will be deleted.',
							'Deleted and replaced remote files remain recoverable for 30 days.',
					],
					confirmText: 'Force full update',
					warning: true,
				});
				if (!confirmed) {
					return;
				}

				await runButtonTask({
					button,
					idleText: 'Force full update',
					runningText: 'Syncing...',
					onStart: () => {
						showFileSyncProgress(forceProgress);
					},
					task: async ({ setButtonText }) => plugin.syncRuntime.forceFullSync((current, total) => {
						setButtonText(`Syncing... ${current}/${total}`);
						updateFileSyncProgress(forceProgress, current, total);
					}),
					onSuccess: (result) => {
						if (result.success) {
							new Notice(`Force sync complete: ${result.uploaded} uploaded, ${result.deleted} deleted`);
						} else {
							showSyncErrorNotice(plugin, 'Force sync completed with errors.');
						}
					},
					onError: () => {
						new Notice('Force full sync failed');
					},
					onFinally: () => {
						hideFileSyncProgress(forceProgress);
						rerender();
					},
				});
			}));
	const forceProgress = createFileSyncProgress(forceSyncSetting);

	new Setting(containerEl)
		.setName('Remove ignored remote files')
		.setDesc('Review and delete server copies matching your exclusions. Local files are kept.')
		.addButton(button => button
			.setButtonText('Review and remove')
			.setDestructive()
			.onClick(async () => {
				await runButtonTask({
					button,
					idleText: 'Review and remove',
					runningText: 'Checking...',
					task: async () => {
						const paths = await plugin.syncRuntime.previewIgnoredRemoteFiles();
						if (paths.length === 0) return null;
						const confirmed = await openConfirmationModal(plugin.app, {
							title: 'Remove ignored remote files',
							message: `Delete ${paths.length} ignored remote ${paths.length === 1 ? 'file' : 'files'}?`,
							details: [
								...paths.slice(0, 5),
								...(paths.length > 5 ? [`…and ${paths.length - 5} more`] : []),
								'Deleted files remain recoverable for 30 days.',
							],
							confirmText: 'Remove remote copies',
							warning: true,
						});
						return confirmed ? plugin.syncRuntime.purgeIgnoredRemoteFiles() : undefined;
					},
					onSuccess: result => {
						if (result === null) new Notice('No ignored remote files found');
						else if (result?.errors.length) new Notice(`Removed ${result.deleted.length} files; ${result.errors.length} failed`);
						else if (result) new Notice(`Removed ${result.deleted.length} ignored remote files`);
					},
					onError: () => {
						new Notice('Could not remove ignored remote files');
					},
				});
			}));
}
