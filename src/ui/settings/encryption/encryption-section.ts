import { Setting, type ButtonComponent } from 'obsidian';
import type CratePlugin from '../../../plugin/CratePlugin';
import { readEncryptionStatus } from '../../../plugin/encryption-setup';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { createLogger } from '../../../sync/logger';
import { errorMessage } from '../../../platform/logger';
import { getPluginLifecycleSignal } from '../../../plugin/lifecycle-state';
import { cachedSettingsRequest } from '../../../plugin/settings-ui-state';
import { EncryptionResetModal } from './encryption-reset-modal';
import { SECRET_KEYS } from '../../../platform/secret-keys';
import { EncryptionModal, encryptionModalTitle } from './encryption-modal';

const log = createLogger('EncryptionSettings');

export function renderEncryptionSection(container: HTMLElement, plugin: CratePlugin): () => void {
	if (!plugin.settings.workerUrl) return () => {};
	const row = new Setting(container).setName('End-to-end encryption');
	const signal = getPluginLifecycleSignal(plugin);
	let disposed = false, revision = 0, loading = false, retry = false;
	let modalTitle = encryptionModalTitle(null);
	let action: ButtonComponent;
	const active = () => !disposed && !signal.aborted;
	const show = (status: string, description: string, label: string) => {
		row.descEl.empty();
		row.descEl.createEl('strong', { text: status });
		row.descEl.createSpan({ text: ` · ${description}` });
		action.setButtonText(label).setDisabled(loading);
	};
	const refresh = async () => {
		if (!active()) return;
		const request = ++revision;
		loading = false; retry = false;
		// Reset checkpoints must remain reachable after their old credentials are revoked.
		if (plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) {
			show('Reset in progress', 'Finish the sync reset on this device.', 'Resume reset'); return;
		}
		loading = true;
		show('Checking…', 'Checking this server’s encryption status.', 'Checking…');
		try {
			const state = await cachedEncryptionStatus(plugin);
			if (!active() || request !== revision) return;
			loading = false;
			modalTitle = encryptionModalTitle(state);
			if (state?.mode === 'resetting') show('Reset in progress', 'Continue on the device that started the reset.', 'View reset');
			else if (state) show('On', 'Synced notes, attachments and history are encrypted.', 'Manage encryption');
			else show('Off', 'Keep synced notes, attachments and history private from your server.', 'Enable encryption');
		} catch (error) {
			if (!active() || request !== revision) return;
			log.warn('Could not check server encryption status:', errorMessage(error));
			loading = false; retry = true;
			show('Status unavailable', 'Could not check this server. Retry to see whether encryption is on.', 'Retry');
		}
	};
	const changed = () => { plugin.settingsUiState.encryptionStatus = null; void refresh(); };
	row.addButton(button => {
		action = button;
		button.onClick(() => {
			if (!active() || loading) return;
			if (retry) { changed(); return; }
			if (plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) new EncryptionResetModal(plugin, null, changed).open();
			else new EncryptionModal(plugin, changed, modalTitle).open();
		});
	});
	void refresh();
	return () => { disposed = true; };
}

/** Settings re-render on every toggle; reuse this connection's answer until the tab closes or encryption changes. */
function cachedEncryptionStatus(plugin: CratePlugin): Promise<EncryptionServerState | null> {
	const client = plugin.syncRuntime.getApiClient();
	if (!client) return readEncryptionStatus(plugin, 7000);
	return cachedSettingsRequest(plugin.settingsUiState, 'encryptionStatus', { client }, () => readEncryptionStatus(plugin, 7000));
}
