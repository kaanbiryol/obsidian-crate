import { Setting } from 'obsidian';
import type { SettingsSectionContext } from '../section-helpers';
import { openSyncActivity, runSyncNow } from '../../../plugin/sync-integration';
import { syncConnectionFailureMessage } from './self-hosted-errors';

export function renderConnectionStatus({ containerEl, plugin }: Omit<SettingsSectionContext, 'rerender'>): () => void {
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
	// Sync activity shows progress and owns Stop sync, so one button covers both.
	setting.addButton(button => button.setButtonText('Sync now').setCta().onClick(async () => {
		button.setDisabled(true);
		try {
			openSyncActivity(plugin);
			await runSyncNow(plugin);
		} finally { button.setDisabled(false); }
	}));
	render();
	runtime.addStateChangeListener(render);
	return () => runtime.removeStateChangeListener(render);
}
