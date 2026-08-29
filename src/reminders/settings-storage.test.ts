import { beforeEach, describe, expect, it, vi } from 'vitest';
import type CratePlugin from '../main';
import {
	DEFAULT_REMINDERS_SETTINGS,
	type RemindersSettings,
	useRemindersSettingsStore,
} from './settings';
import { loadRemindersSettings } from './settings-storage';

function createPlugin(settings: Record<string, unknown> | null): {
	plugin: CratePlugin;
	write: ReturnType<typeof vi.fn>;
} {
	const configDir = 'vault-config';
	const settingsPath = `${configDir}/plugins/crate/reminders-settings.json`;
	const write = vi.fn(async () => undefined);
	const adapter = {
		exists: vi.fn(async (path: string) => path === settingsPath ? settings !== null : true),
		read: vi.fn(async () => JSON.stringify(settings)),
		write,
		mkdir: vi.fn(async () => undefined),
	};
	const plugin = {
		app: {
			vault: {
				configDir,
				adapter,
			},
		},
		manifest: { id: 'crate' },
		remindersSettings: null,
	} as unknown as CratePlugin;

	return { plugin, write };
}

function canonicalSettings(): RemindersSettings {
	return {
		...DEFAULT_REMINDERS_SETTINGS,
		queryViewPreferences: {},
	};
}

describe('loadRemindersSettings', () => {
	beforeEach(() => {
		useRemindersSettingsStore.setState(canonicalSettings(), true);
	});

	it('does not rewrite an unchanged canonical settings file', async () => {
		const settings = canonicalSettings();
		const { plugin, write } = createPlugin(settings);

		await loadRemindersSettings(plugin);

		expect(plugin.remindersSettings).toEqual(settings);
		expect(write).not.toHaveBeenCalled();
	});

	it('persists legacy settings once after normalization', async () => {
		const { plugin, write } = createPlugin({
			...canonicalSettings(),
			autoOpenSidebarOnMobile: true,
			syncMethod: 'legacy',
		});

		await loadRemindersSettings(plugin);

		expect(plugin.remindersSettings.autoOpenView).toBe('sidebar');
		expect(write).toHaveBeenCalledOnce();
		const persisted = JSON.parse(String(write.mock.calls[0]?.[1])) as Record<string, unknown>;
		expect(persisted).not.toHaveProperty('autoOpenSidebarOnMobile');
		expect(persisted).not.toHaveProperty('syncMethod');
	});

	it('creates the settings file when it does not exist', async () => {
		const { plugin, write } = createPlugin(null);

		await loadRemindersSettings(plugin);

		expect(write).toHaveBeenCalledOnce();
	});
});
