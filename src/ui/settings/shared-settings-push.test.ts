import { describe, expect, it, vi } from 'vitest';
import type CratePlugin from '../../plugin/CratePlugin';
import { createSharedSettingsPush } from './shared-settings-push';

function fixture() {
	const settings = { ignorePatterns: ['*.tmp'], syncInterval: 5, pushEnabled: true };
	let api: object | null = {};
	const pushSharedSettingsBestEffort = vi.fn(async () => true);
	const plugin = { settings, syncRuntime: { getApiClient: () => api, pushSharedSettingsBestEffort } };
	const push = createSharedSettingsPush(plugin as unknown as CratePlugin);
	return { push, settings, pushSharedSettingsBestEffort, setApi: (next: object | null) => { api = next; } };
}

describe('shared settings push on settings close', () => {
	it('pushes only when shared settings changed for the current server', () => {
		const { push, settings, pushSharedSettingsBestEffort, setApi } = fixture();
		push();
		push();
		expect(pushSharedSettingsBestEffort).toHaveBeenCalledOnce();

		settings.syncInterval = 10;
		push();
		expect(pushSharedSettingsBestEffort).toHaveBeenCalledTimes(2);

		setApi({});
		push();
		expect(pushSharedSettingsBestEffort).toHaveBeenCalledTimes(3);

		setApi(null);
		push();
		expect(pushSharedSettingsBestEffort).toHaveBeenCalledTimes(3);
	});

	it('retries on the next close after a failed push', async () => {
		const { push, pushSharedSettingsBestEffort } = fixture();
		pushSharedSettingsBestEffort.mockResolvedValueOnce(false);
		push();
		await new Promise(resolve => setTimeout(resolve, 0));
		push();
		expect(pushSharedSettingsBestEffort).toHaveBeenCalledTimes(2);
	});
});
