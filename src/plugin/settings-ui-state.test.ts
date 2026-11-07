import { expect, it, vi } from 'vitest';
import { cachedSettingsRequest, clearSettingsRequests, clearSettingsUiState, createSettingsUiState, loadConnectedDevices } from './settings-ui-state';
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

it('clears server requests when settings close and every cache when the connection changes', () => {
	const state = createSettingsUiState();
	const fill = () => Object.assign(state, {
		diagnostics: { key: 'https://server.test', results: [] }, devices: { client, tokens: [], pending: null },
		encryptionStatus: { client, value: Promise.resolve(null) }, notificationPolicy: { client, folderPath: 'Reminders', value: Promise.resolve(null) },
	});
	fill(); clearSettingsRequests(state);
	expect(state).toMatchObject({ encryptionStatus: null, notificationPolicy: null, devices: { client }, diagnostics: { key: 'https://server.test' } });
	fill(); clearSettingsUiState(state);
	expect(state).toEqual(createSettingsUiState());
});

it('lists connected devices once per client and again for another connection', async () => {
	const listTokens = vi.fn(async () => ({ tokens: [] }));
	let api: unknown = { listTokens };
	const plugin = { settingsUiState: createSettingsUiState(), syncRuntime: { getApiClient: () => api } } as never;
	await Promise.all([loadConnectedDevices(plugin), loadConnectedDevices(plugin)]);
	expect(await loadConnectedDevices(plugin)).toEqual([]);
	expect(listTokens).toHaveBeenCalledOnce();
	api = { listTokens };
	await loadConnectedDevices(plugin);
	expect(listTokens).toHaveBeenCalledTimes(2);
	api = null;
	expect(await loadConnectedDevices(plugin)).toBeNull();
});
