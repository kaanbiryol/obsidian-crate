import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CratePlugin from './CratePlugin';
import { beginPluginLifecycle, endPluginLifecycle } from './lifecycle-state';
import { normalizeCrateSettings } from './settings';
import { DEFAULT_REMINDERS_SETTINGS, useRemindersSettingsStore } from '../reminders/settings';
import * as syncLogger from './logger';
import * as remindersLogger from '../reminders/utils/logger';

vi.mock('../reminders/plugin-integration', () => ({ initializeReminders: vi.fn(), reinitializeReminders: vi.fn() }));
vi.mock('../reminders/ui/workspaceLayout', () => ({ activateOrRevealRemindersLeaf: vi.fn() }));
vi.mock('./lifecycle', () => ({ bootstrapPlugin: vi.fn(), shutdownPlugin: vi.fn() }));

function createPlugin() {
	const plugin = new CratePlugin({} as never, {} as never);
	const saveData = vi.fn<(value: unknown) => Promise<void>>(async () => {});
	Object.assign(plugin, {
		app: { vault: { configDir: '.obsidian' } },
		settings: normalizeCrateSettings({}, '.obsidian'),
		saveData,
	});
	return { plugin, saveData };
}

function pauseFirstSave(saveData: ReturnType<typeof createPlugin>['saveData']) {
	let release!: () => void;
	saveData.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
	return () => release();
}

beforeEach(() => { useRemindersSettingsStore.setState({ ...DEFAULT_REMINDERS_SETTINGS }, true); });
afterEach(() => { vi.restoreAllMocks(); });

describe('queued settings writes across plugin lifetimes', () => {
	it('does not dispatch a queued deployment checkpoint after unload', async () => {
		const { plugin, saveData } = createPlugin();
		const release = pauseFirstSave(saveData);
		const active = plugin.writeSettings({ syncInterval: 120 });
		const activeRejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(saveData).toHaveBeenCalledOnce());
		const checkpoint = plugin.writeSettings({ cloudflareDeployment: {
			deploymentId: '0123456789abcdef', accountId: 'a'.repeat(32), accountName: 'Personal',
			workerName: 'crate-0123456789abcdef', d1DatabaseName: 'crate-0123456789abcdef',
			d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef', r2BucketName: 'crate-0123456789abcdef',
			workersSubdomain: 'example', lastDeployedVersion: '0.1.0', lastDeployedFingerprint: null,
		} });
		const checkpointRejected = expect(checkpoint).rejects.toMatchObject({ name: 'AbortError' });
		endPluginLifecycle(plugin);
		release();
		await Promise.all([activeRejected, checkpointRejected]);
		expect(saveData).toHaveBeenCalledOnce();
		expect(plugin.settings.cloudflareDeployment).toBeNull();
		expect(plugin.settings.syncInterval).toBe(300);
	});

	it.each(['core', 'reminders', 'debug', 'snapshot'] as const)('does not publish an in-flight %s save after another instance loads', async kind => {
		const { plugin: old, saveData } = createPlugin();
		const release = pauseFirstSave(saveData);
		const syncLogging = vi.spyOn(syncLogger, 'configureSyncLogger');
		const reminderLogging = vi.spyOn(remindersLogger, 'configureLogger');
		const active = kind === 'core' ? old.writeSettings({ syncInterval: 120 })
			: kind === 'reminders' ? old.writeRemindersSettings({ remindersFolderPath: 'Stale' })
				: kind === 'debug' ? old.setDebugLogging(true) : old.saveSettings();
		const rejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(saveData).toHaveBeenCalledOnce());
		endPluginLifecycle(old);
		old.settings.syncInterval = 42;
		const { plugin: current } = createPlugin();
		Object.assign(current, { loadData: async () => ({ reminders: { remindersFolderPath: 'Current' }, debugLogging: false }) });
		await current.loadSettings();
		const syncCalls = syncLogging.mock.calls.length;
		const reminderCalls = reminderLogging.mock.calls.length;
		release();
		await rejected;
		expect(old.settings.syncInterval).toBe(42);
		expect(old.settings.debugLogging).toBe(false);
		expect(current.remindersSettings.remindersFolderPath).toBe('Current');
		expect(syncLogging).toHaveBeenCalledTimes(syncCalls);
		expect(reminderLogging).toHaveBeenCalledTimes(reminderCalls);
	});

	it('rejects new saves after unload and allows saves under a fresh lifecycle', async () => {
		const { plugin, saveData } = createPlugin();
		endPluginLifecycle(plugin);
		await expect(plugin.writeSettings({ syncInterval: 120 })).rejects.toMatchObject({ name: 'AbortError' });
		await expect(plugin.writeRemindersSettings({ remindersFolderPath: 'Stale' })).rejects.toMatchObject({ name: 'AbortError' });
		await expect(plugin.saveSettings()).rejects.toMatchObject({ name: 'AbortError' });
		await expect(plugin.setDebugLogging(true)).rejects.toMatchObject({ name: 'AbortError' });
		expect(saveData).not.toHaveBeenCalled();
		beginPluginLifecycle(plugin);
		await plugin.writeSettings({ syncInterval: 60 });
		expect(saveData).toHaveBeenCalledOnce();
		expect(plugin.settings.syncInterval).toBe(60);
	});

	it('keeps old queued writes cancelled when the same instance begins a new lifecycle', async () => {
		const { plugin, saveData } = createPlugin();
		const release = pauseFirstSave(saveData);
		const active = plugin.writeSettings({ syncInterval: 120 });
		const activeRejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(saveData).toHaveBeenCalledOnce());
		const queued = plugin.writeSettings({ workerUrl: 'https://stale.example.workers.dev' });
		const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
		beginPluginLifecycle(plugin);
		const current = plugin.writeSettings({ syncInterval: 60 });
		release();
		await Promise.all([activeRejected, queuedRejected, current]);
		expect(saveData).toHaveBeenCalledTimes(2);
		expect(saveData).toHaveBeenLastCalledWith(expect.objectContaining({ syncInterval: 60, workerUrl: '' }));
		expect(plugin.settings.syncInterval).toBe(60);
		expect(plugin.settings.workerUrl).toBe('');
	});
});
