import { beforeEach, describe, expect, it, vi } from 'vitest';
import CratePlugin from './CratePlugin';
import { normalizeCrateSettings } from './settings';
import { ensurePluginDeviceId } from './deviceId';
import { recordSyncHistory } from '../sync/runtime-history';
import { createEmptySyncResult } from '../sync/sync-result';
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

	it.each(['snapshot', 'update'] as const)('preserves hydrated device identity after a successful %s save', async kind => {
		const plugin = new CratePlugin({} as never, {} as never);
		const saveData = vi.fn(async (_data: unknown) => {});
		const settings = normalizeCrateSettings({}, 'vault-config');
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			secretStorage: { get: () => 'device-local' },
			saveData,
			settings,
		});
		ensurePluginDeviceId(plugin);

		if (kind === 'snapshot') await plugin.saveSettings();
		else await plugin.writeSettings({ syncInterval: 120 });

		expect(plugin.settings).toBe(settings);
		expect(plugin.settings.deviceId).toBe('device-local');
		expect(saveData).toHaveBeenCalledOnce();
		expect(saveData.mock.calls[0]![0]).not.toHaveProperty('deviceId');
	});

	it.each(['snapshot', 'update'] as const)('preserves hydrated device identity after a rejected %s save', async kind => {
		const plugin = new CratePlugin({} as never, {} as never);
		const saveData = vi.fn(async (_data: unknown) => { throw new Error('disk full'); });
		const settings = normalizeCrateSettings({}, 'vault-config');
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			secretStorage: { get: () => 'device-local' },
			saveData,
			settings,
		});
		ensurePluginDeviceId(plugin);

		await expect(kind === 'snapshot' ? plugin.saveSettings() : plugin.writeSettings({ syncInterval: 120 }))
			.rejects.toThrow('disk full');

		expect(plugin.settings).toBe(settings);
		expect(plugin.settings.deviceId).toBe('device-local');
		expect(plugin.settings.syncInterval).toBe(300);
		expect(saveData.mock.calls[0]![0]).not.toHaveProperty('deviceId');
	});

	it.each(['snapshot', 'update', 'debug'] as const)('preserves sync progress completed during a delayed %s save', async kind => {
		const plugin = new CratePlugin({} as never, {} as never);
		const settings = normalizeCrateSettings({ lastSeq: 10, lastSync: '2026-10-05T12:00:00Z' }, '.obsidian');
		let release!: () => void;
		const saveData = vi.fn<(value: unknown) => Promise<void>>(async () => {});
		saveData.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
		Object.assign(plugin, { app: { vault: { configDir: '.obsidian' } }, settings, saveData });
		const saving = kind === 'snapshot' ? plugin.saveSettings()
			: kind === 'update' ? plugin.writeSettings({ syncInterval: 120 }) : plugin.setDebugLogging(true);
		await vi.waitFor(() => expect(saveData).toHaveBeenCalledOnce());
		settings.lastSeq = 11;
		settings.lastSync = '2026-10-06T12:00:00Z';
		recordSyncHistory(settings, 'sync', createEmptySyncResult());
		const progress = { lastSeq: 11, lastSync: settings.lastSync, syncHistory: structuredClone(settings.syncHistory) };
		const persistedProgress = plugin.saveSettings();
		release();
		await Promise.all([saving, persistedProgress]);
		expect(plugin.settings).toBe(settings);
		expect(settings).toMatchObject(progress);
		expect(settings.syncHistory).toHaveLength(1);
		expect(saveData).toHaveBeenLastCalledWith(expect.objectContaining(progress));
		expect(settings.syncInterval).toBe(kind === 'update' ? 120 : 300);
		expect(settings.debugLogging).toBe(kind === 'debug');
	});

	it('publishes normalized requested settings and invalidates a checkpoint scope when its address changes', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const saveData = vi.fn<(value: unknown) => Promise<void>>(async () => {});
		Object.assign(plugin, { app: { vault: { configDir: '.obsidian' } }, saveData,
			settings: normalizeCrateSettings({ workerUrl: 'https://old.example', checkpointScope: {
				workerUrl: 'https://old.example', authority: 'https://original.example',
			} }, '.obsidian'),
		});
		await plugin.writeSettings({ workerUrl: ' https://new.example/ ', ignorePatterns: ['secret/', 'secret/'] });
		expect(plugin.settings.workerUrl).toBe('https://new.example');
		expect(plugin.settings.ignorePatterns).toEqual(['secret/', '.obsidian/workspace*']);
		expect(plugin.settings).not.toHaveProperty('checkpointScope');
		expect(saveData.mock.calls[0]![0]).not.toHaveProperty('checkpointScope');
	});

	it('retains sync progress and a queued save when a preference write fails', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const settings = normalizeCrateSettings({ lastSeq: 10 }, '.obsidian');
		let reject!: (error: Error) => void;
		const saveData = vi.fn<(value: unknown) => Promise<void>>(async () => {});
		saveData.mockImplementationOnce(() => new Promise((_resolve, rejectWrite) => { reject = rejectWrite; }));
		Object.assign(plugin, { app: { vault: { configDir: '.obsidian' } }, settings, saveData });
		const saving = plugin.writeSettings({ syncInterval: 120 });
		const rejected = expect(saving).rejects.toThrow('disk full');
		await vi.waitFor(() => expect(saveData).toHaveBeenCalledOnce());
		settings.lastSeq = 11;
		recordSyncHistory(settings, 'sync', createEmptySyncResult());
		const progressSave = plugin.saveSettings();
		reject(new Error('disk full'));
		await Promise.all([rejected, progressSave]);
		expect(settings.lastSeq).toBe(11);
		expect(settings.syncHistory).toHaveLength(1);
		expect(settings.syncInterval).toBe(300);
		expect(saveData).toHaveBeenLastCalledWith(expect.objectContaining({ lastSeq: 11, syncHistory: settings.syncHistory, syncInterval: 300 }));
	});


	it('stops local reminders without deleting notes when disabled', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const unregister = vi.fn();
		const detachLeavesOfType = vi.fn();
		Object.assign(plugin, {
			app: { vault: { configDir: '.obsidian' }, workspace: { detachLeavesOfType } },
			settings: normalizeCrateSettings({}, '.obsidian'),
			saveData: vi.fn(async () => {}), remindersVaultWatcher: { unregister },
		});
		await plugin.setRemindersEnabled(false);
		expect(plugin.remindersSettings.enabled).toBe(false);
		expect(unregister).toHaveBeenCalledOnce();
		expect(detachLeavesOfType).toHaveBeenCalledWith('reminders-view');
		await plugin.setRemindersEnabled(true);
		expect(plugin.remindersSettings.enabled).toBe(true);
		expect(initializeReminders).toHaveBeenCalledOnce();
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

	it('enables reminders when no reminders settings have been saved', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			loadData: vi.fn(async () => ({ syncInterval: 120 })),
		});

		await plugin.loadSettings();

		expect(plugin.remindersSettings.enabled).toBe(true);
	});

	it('does not publish settings from an unloaded instance after a newer instance loads', async () => {
		const { endPluginLifecycle } = await import('./lifecycle-state');
		const old = new CratePlugin({} as never, {} as never);
		let finish!: (value: unknown) => void;
		Object.assign(old, { app: { vault: { configDir: '.obsidian' } }, loadData: () => new Promise(resolve => { finish = resolve; }) });
		const loading = old.loadSettings();
		endPluginLifecycle(old);
		const current = new CratePlugin({} as never, {} as never);
		Object.assign(current, { app: { vault: { configDir: '.obsidian' } }, loadData: async () => ({ reminders: { enabled: true, remindersFolderPath: 'Current' } }) });
		await current.loadSettings();
		finish({ reminders: { enabled: true, remindersFolderPath: 'Stale' } });
		await loading;
		expect(current.remindersSettings).toMatchObject({ enabled: true, remindersFolderPath: 'Current' });
		expect(old.settings).toBeUndefined();
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

		await plugin.writeRemindersSettings({ upcomingDaysDefault: 14, listStyle: 'cards' });

		expect(plugin.remindersSettings.upcomingDaysDefault).toBe(14);
		expect(plugin.remindersSettings.listStyle).toBe('cards');
		const persisted = saveData.mock.calls[0]?.[0] as {
			reminders?: { upcomingDaysDefault?: number; listStyle?: string };
		};
		expect(persisted.reminders?.upcomingDaysDefault).toBe(14);
		expect(persisted.reminders?.listStyle).toBe('cards');
	});

	it('keeps reminder settings unchanged when their combined data write fails', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			saveData: vi.fn().mockRejectedValue(new Error('disk full')),
			settings: normalizeCrateSettings({}, 'vault-config'),
		});

		await expect(plugin.writeRemindersSettings({ upcomingDaysDefault: 14, listStyle: 'cards' }))
			.rejects.toThrow('disk full');

		expect(plugin.remindersSettings.upcomingDaysDefault).toBe(
			DEFAULT_REMINDERS_SETTINGS.upcomingDaysDefault,
		);
		expect(plugin.remindersSettings.listStyle).toBe('flat');
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
			settings: { ...normalizeCrateSettings({}, 'vault-config'), deviceId: 'device-local' },
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
		expect(plugin.settings.deviceId).toBe('device-local');
		for (const saved of persisted) expect(saved).not.toHaveProperty('deviceId');
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
