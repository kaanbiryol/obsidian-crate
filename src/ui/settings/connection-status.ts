import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { ActivityModal } from '../activity-modal';
import { notifyConflicts } from '../../sync/conflict';
import { showSyncErrorNotice } from '../sync-error-notice';
import { errorMessage } from '../../plugin/logger';
import { syncConnectionFailureMessage } from './self-hosted-errors';

export function renderConnectionStatus(containerEl: HTMLElement, plugin: CratePlugin): () => void {
	const runtime = plugin.syncRuntime;
	const setting = new Setting(containerEl).setName('Sync status');
	const render = () => {
		const state = runtime.getState();
		const status = state.status === 'syncing' ? 'Syncing…'
			: state.status === 'offline' ? 'Server unavailable'
				: state.status === 'error' ? 'Sync failed'
					: state.pendingChanges ? `${state.pendingChanges} pending changes` : state.lastSync ? 'Up to date' : 'Not synced yet';
		const lastSync = state.lastSync ? new Date(state.lastSync).toLocaleString() : 'Never';
		const issue = state.lastError && state.status === 'error'
			? syncConnectionFailureMessage(state.lastError, plugin.settings.workerUrl) ?? state.lastError
			: state.lastError;
		setting.setDesc(`${status} · Last successful sync: ${lastSync}${issue ? ` · ${issue}` : ''}`);
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
	setting.addButton(button => button.setButtonText('Stop sync').onClick(async () => {
		button.setDisabled(true);
		try {
			await runtime.stopSync();
			plugin.refreshSettingsTab();
			new Notice('Sync stopped. Automatic sync is off on this device.');
		} catch (error) {
			new Notice(`Could not finish stopping sync: ${errorMessage(error)}`);
		} finally { button.setDisabled(false); render(); }
	}));
	setting.addButton(button => button.setButtonText('View activity').onClick(() => {
		new ActivityModal(plugin.app, plugin.settings, runtime).open();
	}));
	render();
	runtime.addStateChangeListener(render);
	return () => runtime.removeStateChangeListener(render);
}
