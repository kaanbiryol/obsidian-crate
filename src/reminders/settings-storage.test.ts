import { beforeEach, describe, expect, it, vi } from 'vitest';
import type CratePlugin from '../main';
import {
	DEFAULT_REMINDERS_SETTINGS,
	type RemindersSettings,
	useRemindersSettingsStore,
} from './settings';
import { loadRemindersSettings, writeRemindersSettings } from './settings-storage';

function createPlugin(
	settings: Record<string, unknown> | null,
	writeImplementation: () => Promise<void> = async () => undefined,
): {
	plugin: CratePlugin;
	write: ReturnType<typeof vi.fn>;
} {
	const configDir = 'vault-config';
	const settingsPath = `${configDir}/plugins/crate/reminders-settings.json`;
	const write = vi.fn(writeImplementation);
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

	it('persists noncanonical settings once after normalization', async () => {
		const { plugin, write } = createPlugin({
			...canonicalSettings(),
			upcomingDaysDefault: -1,
			unknownSetting: true,
		});

		await loadRemindersSettings(plugin);

		expect(plugin.remindersSettings.upcomingDaysDefault).toBe(
			DEFAULT_REMINDERS_SETTINGS.upcomingDaysDefault,
		);
		expect(write).toHaveBeenCalledOnce();
		const persisted = JSON.parse(String(write.mock.calls[0]?.[1])) as Record<string, unknown>;
		expect(persisted).not.toHaveProperty('unknownSetting');
	});

	it('creates the settings file when it does not exist', async () => {
		const { plugin, write } = createPlugin(null);

		await loadRemindersSettings(plugin);

		expect(write).toHaveBeenCalledOnce();
	});

	it('leaves runtime settings unchanged when persistence fails', async () => {
		const initialSettings = canonicalSettings();
		useRemindersSettingsStore.setState(initialSettings, true);
		const { plugin } = createPlugin(initialSettings, async () => {
			throw new Error('vault is read-only');
		});
		plugin.remindersSettings = initialSettings;

		await expect(writeRemindersSettings(plugin, {
			upcomingDaysDefault: 14,
		})).rejects.toThrow('vault is read-only');

		expect(plugin.remindersSettings).toEqual(initialSettings);
		expect(useRemindersSettingsStore.getState()).toEqual(initialSettings);
	});
});
