import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { ActivityModal } from '../activity-modal';
import { notifyConflicts } from '../../sync/conflict';
import { showSyncErrorNotice } from '../sync-error-notice';
import { errorMessage } from '../../plugin/logger';

export function renderConnectionStatus(containerEl: HTMLElement, plugin: CratePlugin): () => void {
	const runtime = plugin.syncRuntime;
	const setting = new Setting(containerEl).setName('Sync status');
	const render = () => {
		const state = runtime.getState();
		const status = state.status === 'syncing' ? 'Syncing…'
			: state.status === 'offline' ? 'Offline'
				: state.status === 'error' ? 'Sync failed'
					: state.pendingChanges ? `${state.pendingChanges} pending changes` : 'Ready';
		const lastSync = state.lastSync ? new Date(state.lastSync).toLocaleString() : 'Never';
		setting.setDesc(`${plugin.settings.workerUrl} · ${status} · Last successful sync: ${lastSync}${state.lastError ? ` · ${state.lastError}` : ''}`);
	};
	setting.addButton(button => button.setButtonText('Sync now').onClick(async () => {
		button.setDisabled(true);
		try {
			const result = await runtime.sync();
			if (!result.success) showSyncErrorNotice(plugin, 'Sync completed with errors.');
			notifyConflicts(result.conflicts);
		} catch (error) {
			new Notice(`Sync failed: ${errorMessage(error)}`);
		} finally { button.setDisabled(false); }
	}));
	setting.addButton(button => button.setButtonText('View activity').onClick(() => {
		new ActivityModal(plugin.app, plugin.settings, runtime).open();
	}));
	render();
	runtime.addStateChangeListener(render);
	return () => runtime.removeStateChangeListener(render);
}
