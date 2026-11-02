import { expect, it, vi } from 'vitest';
import { cachedSettingsRequest, createSettingsUiState } from './settings-ui-state';
import type { SyncApiClient } from '../sync/worker-api/client';

const client = {} as SyncApiClient, other = {} as SyncApiClient;

it('shares a settings request per client and folder until it fails', async () => {
	const state = createSettingsUiState();
	const load = vi.fn(async () => null);
	const first = cachedSettingsRequest(state, 'notificationPolicy', { client, folderPath: 'Reminders' }, load);
	expect(cachedSettingsRequest(state, 'notificationPolicy', { client, folderPath: 'Reminders' }, load)).toBe(first);
	void cachedSettingsRequest(state, 'notificationPolicy', { client, folderPath: 'Tasks' }, load);
	void cachedSettingsRequest(state, 'notificationPolicy', { client: other, folderPath: 'Tasks' }, load);
	expect(load).toHaveBeenCalledTimes(3);

	const failing = cachedSettingsRequest(state, 'encryptionStatus', { client }, () => Promise.reject(new Error('Offline')));
	await expect(failing).rejects.toThrow('Offline');
	expect(state.encryptionStatus).toBeNull();
});
