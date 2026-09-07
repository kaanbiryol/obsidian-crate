import { afterEach, expect, it, vi } from 'vitest';
import { endPluginLifecycle } from '../plugin/lifecycle-state';
import { DEFAULT_SETTINGS } from '../plugin/settings';
import { SyncApiClient } from './api';
import { configureCloudflareAuthorizedDevice } from './plugin-integration';

afterEach(() => vi.restoreAllMocks());

it('does not apply remote settings or connect after unloading during the shared settings request', async () => {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS },
		syncRuntime: {
			applyInfrastructureConfig: vi.fn(),
			pushSharedSettingsBestEffort: vi.fn(),
			testConnection: vi.fn(),
		},
	};
	vi.spyOn(SyncApiClient.prototype, 'getSharedSettings').mockImplementation(async () => {
		endPluginLifecycle(plugin as never);
		return { settings: { ...DEFAULT_SETTINGS, ignorePatterns: ['remote-pattern'] }, settingsVersion: 'version' };
	});
	await expect(configureCloudflareAuthorizedDevice(plugin as never, 'https://crate.example.workers.dev', 'token'))
		.rejects.toMatchObject({ name: 'AbortError' });
	expect(plugin.settings.ignorePatterns).toEqual(DEFAULT_SETTINGS.ignorePatterns);
	expect(plugin.syncRuntime.applyInfrastructureConfig).not.toHaveBeenCalled();
	expect(plugin.syncRuntime.pushSharedSettingsBestEffort).not.toHaveBeenCalled();
	expect(plugin.syncRuntime.testConnection).not.toHaveBeenCalled();
});
