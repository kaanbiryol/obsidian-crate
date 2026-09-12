import { beforeEach, describe, expect, it, vi } from 'vitest';
import CratePlugin from './CratePlugin';
import { normalizeCrateSettings } from './settings';
import { initializeReminders } from '../reminders/plugin-integration';
import {
	DEFAULT_REMINDERS_SETTINGS,
	useRemindersSettingsStore,
} from '../reminders/settings';

vi.mock('../reminders/plugin-integration', () => ({
	initializeReminders: vi.fn(),
	reinitializeReminders: vi.fn(),
}));
vi.mock('../reminders/ui/workspaceLayout', () => ({
	activateOrRevealRemindersLeaf: vi.fn(),
}));
vi.mock('./lifecycle', () => ({
	bootstrapPlugin: vi.fn(),
	shutdownPlugin: vi.fn(),
}));

describe('CratePlugin settings persistence', () => {
	beforeEach(() => {
		vi.mocked(initializeReminders).mockReset();
		useRemindersSettingsStore.setState({ ...DEFAULT_REMINDERS_SETTINGS }, true);
	});

	it('disables reminders, stops watching, and closes views without deleting files', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const unregister = vi.fn();
		const detachLeavesOfType = vi.fn();
		Object.assign(plugin, {
			app: { vault: { configDir: '.obsidian' }, workspace: { detachLeavesOfType } },
			settings: normalizeCrateSettings({}, '.obsidian'),
			saveData: vi.fn(async () => {}),
			remindersVaultWatcher: { unregister },
		});
		useRemindersSettingsStore.setState({ enabled: true });
		await plugin.disableReminders();
		expect(plugin.remindersSettings.enabled).toBe(false);
		expect(unregister).toHaveBeenCalledOnce();
		expect(detachLeavesOfType).toHaveBeenCalledWith('reminders-view');
		expect(plugin.remindersVaultWatcher).toBeUndefined();
	});

	it.each([true, false])('loads the single debug setting: %s', async debugLogging => {
		const plugin = new CratePlugin({} as never, {} as never);
		Object.assign(plugin, { app: { vault: { configDir: '.obsidian' } }, loadData: vi.fn(async () => ({ debugLogging })) });
		await plugin.loadSettings();
		expect(plugin.settings.debugLogging).toBe(debugLogging);
		expect(plugin.remindersSettings).not.toHaveProperty('debugLogging');
	});

	it.each([true, false])('saves the debug setting atomically when logging is %s', async enabled => {
		const plugin = new CratePlugin({} as never, {} as never);
		const saveData = vi.fn(async (_data: unknown) => {});
		Object.assign(plugin, {
			settings: normalizeCrateSettings({ debugLogging: !enabled }, '.obsidian'),
			saveData,
		});
		await plugin.setDebugLogging(enabled);
		expect(saveData).toHaveBeenCalledTimes(1);
		expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
			debugLogging: enabled,
			reminders: DEFAULT_REMINDERS_SETTINGS,
		}));
		expect(plugin.settings.debugLogging).toBe(enabled);
	});

	it('leaves the debug setting unchanged if saving fails', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		Object.assign(plugin, {
			settings: normalizeCrateSettings({}, '.obsidian'),
			saveData: vi.fn().mockRejectedValue(new Error('disk full')),
		});
		await expect(plugin.setDebugLogging(true)).rejects.toThrow('disk full');
		expect(plugin.settings.debugLogging).toBe(false);
	});

	it('loads core and reminder settings from one plugin data record', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			loadData: vi.fn(async () => ({
				syncInterval: 120,
				reminders: {
					enabled: true,
					upcomingDaysDefault: 14,
					remindersFolderPath: 'Reminders/Work',
				},
			})),
		});

		await plugin.loadSettings();

		expect(plugin.settings.syncInterval).toBe(120);
		expect(plugin.remindersSettings).toMatchObject({
			enabled: true,
			upcomingDaysDefault: 14,
			remindersFolderPath: 'Reminders/Work',
		});
	});

	it('keeps reminders disabled when no reminders settings have been saved', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			loadData: vi.fn(async () => ({ syncInterval: 120 })),
		});

		await plugin.loadSettings();

		expect(plugin.remindersSettings.enabled).toBe(false);
	});

	it('does not publish settings from an unloaded instance after a newer instance loads', async () => {
		const { endPluginLifecycle } = await import('./lifecycle-state');
		const old = new CratePlugin({} as never, {} as never);
		let finish!: (value: unknown) => void;
		Object.assign(old, { app: { vault: { configDir: '.obsidian' } }, loadData: () => new Promise(resolve => { finish = resolve; }) });
		const loading = old.loadSettings();
		endPluginLifecycle(old);
		const current = new CratePlugin({} as never, {} as never);
		Object.assign(current, { app: { vault: { configDir: '.obsidian' } }, loadData: async () => ({ reminders: { enabled: false, remindersFolderPath: 'Current' } }) });
		await current.loadSettings();
		finish({ reminders: { enabled: true, remindersFolderPath: 'Stale' } });
		await loading;
		expect(current.remindersSettings).toMatchObject({ enabled: false, remindersFolderPath: 'Current' });
		expect(old.settings).toBeUndefined();
	});

	it('persists consent before scanning reminder files', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const saveData = vi.fn<(data: unknown) => Promise<void>>(async () => undefined);
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			saveData,
			settings: normalizeCrateSettings({}, 'vault-config'),
		});

		await plugin.enableReminders();

		expect(plugin.remindersSettings.enabled).toBe(true);
		const persisted = saveData.mock.calls[0]?.[0] as {
			reminders?: { enabled?: boolean };
		};
		expect(persisted.reminders?.enabled).toBe(true);
		expect(vi.mocked(initializeReminders)).toHaveBeenCalledWith(plugin);
		expect(saveData.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(initializeReminders).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
		);
	});

	it('rolls back the reminder opt-in when initialization fails', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			saveData: vi.fn(async () => undefined),
			settings: normalizeCrateSettings({}, 'vault-config'),
		});
		vi.mocked(initializeReminders).mockRejectedValueOnce(new Error('scan failed'));

		await expect(plugin.enableReminders()).rejects.toThrow('scan failed');

		expect(plugin.remindersSettings.enabled).toBe(false);
	});

	it('preserves the shared settings object across deployment and connection saves', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const saveData = vi.fn(async () => {});
		const settings = normalizeCrateSettings({}, 'vault-config');
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			saveData,
			settings,
		});

		plugin.settings.cloudflareDeployment = {
			deploymentId: '0123456789abcdef',
			accountId: '0123456789abcdef0123456789abcdef',
			accountName: 'Example account',
			workerName: 'crate-0123456789abcdef',
			d1DatabaseName: 'crate-0123456789abcdef',
			d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
			r2BucketName: 'crate-0123456789abcdef',
			workersSubdomain: 'example-account',
			lastDeployedVersion: '0.1.0',
			lastDeployedFingerprint: 'f'.repeat(64),
		};
		await plugin.saveSettings();

		expect(plugin.settings).toBe(settings);

		settings.workerUrl = 'https://crate.example.workers.dev';
		await plugin.saveSettings();

		expect(saveData).toHaveBeenLastCalledWith(expect.objectContaining({
			workerUrl: 'https://crate.example.workers.dev',
			reminders: DEFAULT_REMINDERS_SETTINGS,
		}));
	});

	it('applies proposed settings only after persistence succeeds', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const saveData = vi.fn(async () => {});
		const settings = normalizeCrateSettings({}, 'vault-config');
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			saveData,
			settings,
		});

		await plugin.writeSettings({ syncInterval: 120 });

		expect(plugin.settings).toBe(settings);
		expect(plugin.settings.syncInterval).toBe(120);
		expect(saveData).toHaveBeenCalledWith(expect.objectContaining({ syncInterval: 120 }));
	});

	it('keeps runtime settings unchanged when a proposed write fails', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const settings = normalizeCrateSettings({}, 'vault-config');
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			saveData: vi.fn().mockRejectedValue(new Error('disk full')),
			settings,
		});

		await expect(plugin.writeSettings({ syncInterval: 120 })).rejects.toThrow('disk full');

		expect(plugin.settings).toBe(settings);
		expect(plugin.settings.syncInterval).toBe(300);
	});

	it('applies reminder settings only after the combined data write succeeds', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const saveData = vi.fn(async (_data: unknown) => undefined);
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			saveData,
			settings: normalizeCrateSettings({}, 'vault-config'),
		});

		await plugin.writeRemindersSettings({ upcomingDaysDefault: 14 });

		expect(plugin.remindersSettings.upcomingDaysDefault).toBe(14);
		const persisted = saveData.mock.calls[0]?.[0] as {
			reminders?: { upcomingDaysDefault?: number };
		};
		expect(persisted.reminders?.upcomingDaysDefault).toBe(14);
	});

	it('keeps reminder settings unchanged when their combined data write fails', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			saveData: vi.fn().mockRejectedValue(new Error('disk full')),
			settings: normalizeCrateSettings({}, 'vault-config'),
		});

		await expect(plugin.writeRemindersSettings({ upcomingDaysDefault: 14 }))
			.rejects.toThrow('disk full');

		expect(plugin.remindersSettings.upcomingDaysDefault).toBe(
			DEFAULT_REMINDERS_SETTINGS.upcomingDaysDefault,
		);
	});

	it('serializes combined writes so concurrent core and reminder updates are not lost', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		let finishFirstWrite!: () => void;
		const firstWrite = new Promise<void>((resolve) => {
			finishFirstWrite = resolve;
		});
		const persisted: unknown[] = [];
		const saveData = vi.fn(async (data: unknown) => {
			persisted.push(data);
			if (persisted.length === 1) {
				await firstWrite;
			}
		});
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			saveData,
			settings: normalizeCrateSettings({}, 'vault-config'),
		});

		const coreUpdate = plugin.writeSettings({ syncInterval: 120 });
		await vi.waitFor(() => {
			expect(saveData).toHaveBeenCalledTimes(1);
		});
		const reminderUpdate = plugin.writeRemindersSettings({ upcomingDaysDefault: 14 });

		expect(saveData).toHaveBeenCalledTimes(1);
		finishFirstWrite();
		await Promise.all([coreUpdate, reminderUpdate]);

		const lastPersisted = persisted.at(-1) as {
			syncInterval?: number;
			reminders?: { upcomingDaysDefault?: number };
		};
		expect(lastPersisted.syncInterval).toBe(120);
		expect(lastPersisted.reminders?.upcomingDaysDefault).toBe(14);
	});

	it('opens its settings tab when the host exposes the settings controller', () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const open = vi.fn();
		const openTabById = vi.fn();
		Object.assign(plugin, {
			app: { setting: { open, openTabById } },
			manifest: { id: 'crate' },
		});

		expect(plugin.openSettingsTab()).toBe(true);
		expect(open).toHaveBeenCalledTimes(1);
		expect(openTabById).toHaveBeenCalledWith('crate');
	});

	it('continues safely when the host does not expose settings navigation', () => {
		const plugin = new CratePlugin({} as never, {} as never);
		Object.assign(plugin, {
			app: {},
			manifest: { id: 'crate' },
		});

		expect(plugin.openSettingsTab()).toBe(false);
	});
});
