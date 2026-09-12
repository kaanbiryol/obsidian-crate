import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { openConfirmationModal } from '../confirmation-modal';
import { runButtonTask } from './action-helpers';

export function renderExclusionCleanup(containerEl: HTMLElement, plugin: CratePlugin): void {
	new Setting(containerEl)
		.setName('Remove excluded server files')
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
							title: 'Remove excluded server files',
							message: `Delete ${paths.length} excluded server ${paths.length === 1 ? 'file' : 'files'}?`,
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
						if (result === null) new Notice('No excluded server files found');
						else if (result?.errors.length) new Notice(`Removed ${result.deleted.length} files; ${result.errors.length} failed`);
						else if (result) new Notice(`Removed ${result.deleted.length} excluded server files`);
					},
					onError: () => {
						new Notice('Could not remove excluded server files');
					},
				});
			}));
}
