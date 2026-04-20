import { Notice, Setting } from 'obsidian';
import { setPluginDeviceId } from '../../plugin/deviceId';
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

	new Setting(containerEl)
		.setName('Test connection')
		.setDesc('Verify that the plugin can connect to your sync server')
		.addButton(button => button
			.setButtonText('Test')
			.onClick(async () => {
				await runButtonTask({
					button,
					idleText: 'Test',
					runningText: 'Testing...',
					task: async () => plugin.syncRuntime.testConnection(),
					onSuccess: (result) => {
						if (result.success) {
							new Notice('Connection successful');
						} else {
							new Notice(`Connection failed: ${result.error}`);
						}
					},
					onError: () => {
						new Notice('Connection test failed');
					},
				});
			}));

	new Setting(containerEl)
		.setName('Device ID')
		.setDesc('Unique identifier for this device. Stored locally and not shared through vault sync.')
		.addText(text => text
			.setValue(plugin.settings.deviceId)
			.onChange(async (value) => {
				await setPluginDeviceId(plugin, value);
			}));

	const initialSyncSetting = new Setting(containerEl)
		.setName('Initial sync')
		.setDesc('Upload all local files to the server (use for first-time setup)')
		.addButton(button => button
			.setButtonText('Upload all')
			.setWarning()
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
							new Notice('Initial sync completed with errors');
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
		.setDesc('Overwrite all remote files with local vault and remove remote-only files')
		.addButton(button => button
			.setButtonText('Force full update')
			.setWarning()
			.onClick(async () => {
				const confirmed = await openConfirmationModal(plugin.app, {
					title: 'Force full sync',
					message: 'Overwrite the remote vault with local files?',
					details: [
						'Remote-only files will be deleted.',
						'This action cannot be undone.',
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
							new Notice('Force sync completed with errors');
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
}
