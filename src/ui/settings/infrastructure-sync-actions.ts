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

	const forceSyncSetting = new Setting(containerEl)
		.setName('Replace server files')
		.setDesc('Replace the server copy of your vault with local files. Files found only on the server will be deleted.')
		.addButton(button => button
			.setButtonText('Replace server files')
			.setDestructive()
			.onClick(async () => {
				const confirmed = await openConfirmationModal(plugin.app, {
					title: 'Replace server files',
					message: 'Overwrite the remote vault with local files?',
						details: [
							'Remote-only files will be deleted.',
							'Deleted and replaced remote files remain recoverable for 30 days.',
					],
					confirmText: 'Replace server files',
					warning: true,
				});
				if (!confirmed) {
					return;
				}

				await runButtonTask({
					button,
					idleText: 'Replace server files',
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
							new Notice(`Server files replaced: ${result.uploaded} uploaded, ${result.deleted} deleted`);
						} else {
							showSyncErrorNotice(plugin, 'Server file replacement completed with errors.');
						}
					},
					onError: () => {
						new Notice('Could not replace server files');
					},
					onFinally: () => {
						hideFileSyncProgress(forceProgress);
						rerender();
					},
				});
			}));
	const forceProgress = createFileSyncProgress(forceSyncSetting);
}
