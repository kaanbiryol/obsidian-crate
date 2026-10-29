import { beforeEach, expect, it, vi } from 'vitest';
import type CratePlugin from './CratePlugin';
import { refreshSharedFeatures, registerSharedFeatures, setSharedFeature, SHARED_FEATURES_REFRESH_INTERVAL_MS } from './feature-settings';
import type { SyncState } from '../sync/types';
import { restartReading } from '../reading/runtime';
import { serverRequest } from './server-request';
import { setRemindersEnabled } from '../reminders/plugin-integration';
import { Notice } from '../test/mocks/obsidian';
vi.mock('./server-request', async importOriginal => ({ ...await importOriginal<typeof import('./server-request')>(), serverRequest: vi.fn() }));
vi.mock('../reading/runtime', () => ({ restartReading: vi.fn() }));
vi.mock('../reminders/plugin-integration', () => ({
	setRemindersEnabled: vi.fn(async (plugin: { remindersSettings: { enabled: boolean } }, enabled: boolean) => { plugin.remindersSettings.enabled = enabled; }),
}));
beforeEach(() => { vi.clearAllMocks(); Notice.reset(); });
function fixture() {
	const plugin = {
		settings: { workerUrl: 'https://crate.example', reading: { enabled: true, folderPath: 'Reading', confirmed: true } },
		remindersSettings: { enabled: true, confirmed: true },
		secretStorage: { get: () => 'synthetic' },
		app: { vault: { configDir: '.obsidian' }, workspace: { detachLeavesOfType: vi.fn() } }, refreshSettingsTab: vi.fn(),
		writeSettings: vi.fn(async (value: { reading: { enabled: boolean; folderPath: string; confirmed: boolean } }) => { plugin.settings.reading = value.reading; }),
		writeRemindersSettings: vi.fn(async (value: Partial<{ enabled: boolean; confirmed: boolean }>) => { plugin.remindersSettings = { ...plugin.remindersSettings, ...value }; }),
	};
	return plugin;
}
it('changes the shared policy before applying local state and keeps other feature settings', async () => {
	const plugin = fixture();
	vi.mocked(serverRequest).mockResolvedValueOnce({ reading: true, reminders: true, revision: 'one' })
		.mockResolvedValueOnce({ reading: false, reminders: true, revision: 'two' });
	await setSharedFeature(plugin as unknown as CratePlugin, 'reading', false);
	expect(serverRequest).toHaveBeenLastCalledWith(plugin, '/features', { feature: 'reading', enabled: false, revision: 'one' }, expect.objectContaining({ timeout: 5_000 }));
	expect(plugin.settings.reading.enabled).toBe(false);
	expect(restartReading).toHaveBeenCalledExactlyOnceWith(plugin, false);
	expect(setRemindersEnabled).not.toHaveBeenCalled();
});
it('does not pretend to change the shared feature when the server rejects it', async () => {
	const plugin = fixture();
	vi.mocked(serverRequest).mockResolvedValueOnce({ reading: true, reminders: true, revision: 'one' }).mockRejectedValueOnce(new Error('Offline'));
	await expect(setSharedFeature(plugin as unknown as CratePlugin, 'reading', false)).rejects.toThrow('Offline');
	expect(plugin.writeSettings).not.toHaveBeenCalled();
});
it('pulls paused state before initialization without writing stale local flags back', async () => {
	const plugin = fixture();
	vi.mocked(serverRequest).mockResolvedValue({ reading: false, reminders: false, revision: 'one' });
	await refreshSharedFeatures(plugin as unknown as CratePlugin, false);
	expect(plugin.settings.reading.enabled).toBe(false);
	expect(plugin.remindersSettings.enabled).toBe(false);
	expect(serverRequest).toHaveBeenCalledExactlyOnceWith(plugin, '/features', undefined, { timeout: 5_000 });
	expect(setRemindersEnabled).not.toHaveBeenCalled();
	expect(restartReading).toHaveBeenCalledExactlyOnceWith(plugin, false);
});
it('resumes local backends when another device resumes the server features', async () => {
	const plugin = fixture(); plugin.settings.reading.enabled = false; plugin.remindersSettings.enabled = false;
	vi.mocked(serverRequest).mockResolvedValue({ reading: true, reminders: true, revision: 'one' });
	await refreshSharedFeatures(plugin as unknown as CratePlugin);
	expect(restartReading).toHaveBeenCalledExactlyOnceWith(plugin, true);
	expect(setRemindersEnabled).toHaveBeenCalledWith(plugin, true, expect.any(Function));
	expect(plugin.refreshSettingsTab).toHaveBeenCalledOnce();
});
it('waits for this vault to confirm before a server policy starts a feature, and says so once', async () => {
	const plugin = fixture();
	plugin.settings.reading = { enabled: false, folderPath: 'Reading', confirmed: false };
	plugin.remindersSettings = { enabled: false, confirmed: false };
	vi.mocked(serverRequest).mockResolvedValue({ reading: true, reminders: true, revision: 'one' });
	await refreshSharedFeatures(plugin as unknown as CratePlugin);
	await refreshSharedFeatures(plugin as unknown as CratePlugin);
	expect(plugin.writeSettings).not.toHaveBeenCalled();
	expect(plugin.writeRemindersSettings).not.toHaveBeenCalled();
	expect(restartReading).not.toHaveBeenCalled();
	expect(setRemindersEnabled).not.toHaveBeenCalled();
	expect(plugin.refreshSettingsTab).not.toHaveBeenCalled();
	expect(Notice.messages).toEqual([
		'Reminders are on for your Crate server. To use them in this vault, turn them on in Crate settings.',
		'Reading is on for your Crate server. To use it in this vault, turn it on in Crate settings.',
	]);
});
it('starts a feature the server already has on once this vault turns it on', async () => {
	const plugin = fixture();
	plugin.settings.reading = { enabled: false, folderPath: 'Reading', confirmed: false };
	vi.mocked(serverRequest).mockResolvedValue({ reading: true, reminders: true, revision: 'one' });
	await setSharedFeature(plugin as unknown as CratePlugin, 'reading', true);
	expect(plugin.settings.reading).toEqual({ enabled: true, folderPath: 'Reading', confirmed: true });
	expect(restartReading).toHaveBeenCalledExactlyOnceWith(plugin, true);
	expect(Notice.messages).toEqual([]);
});
it('checks the shared policy at startup and after completed syncs at most every ten minutes, not on a timer', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	try {
	const listeners = new Set<(state: SyncState) => void>();
	const emit = (status: SyncState['status']) => { for (const listener of listeners) listener({ status } as SyncState); };
	const plugin = Object.assign(fixture(), {
		syncRuntime: { addStateChangeListener: (listener: (state: SyncState) => void) => listeners.add(listener), removeStateChangeListener: (listener: (state: SyncState) => void) => listeners.delete(listener) },
		registerInterval: vi.fn(), registerDomEvent: vi.fn(), register: vi.fn(),
	});
	vi.mocked(serverRequest).mockResolvedValue({ reading: true, reminders: true, revision: 'one' });
	registerSharedFeatures(plugin as unknown as CratePlugin);
	await vi.waitFor(() => expect(serverRequest).toHaveBeenCalledOnce());
	// Before: a 30-second interval plus focus and online listeners.
	expect(plugin.registerInterval).not.toHaveBeenCalled();
	expect(plugin.registerDomEvent).not.toHaveBeenCalled();

	emit('idle');
	emit('syncing');
	emit('error');
	await Promise.resolve();
	expect(serverRequest).toHaveBeenCalledOnce();

	// Frequent automatic syncs do not refetch the policy each time.
	emit('syncing');
	emit('idle');
	await Promise.resolve();
	expect(serverRequest).toHaveBeenCalledOnce();

	vi.setSystemTime(Date.now() + SHARED_FEATURES_REFRESH_INTERVAL_MS);
	emit('syncing');
	emit('idle');
	await vi.waitFor(() => expect(serverRequest).toHaveBeenCalledTimes(2));
	} finally { vi.useRealTimers(); }
});
it('retries the shared policy after the next sync when the last check failed', async () => {
	const listeners = new Set<(state: SyncState) => void>();
	const emit = (status: SyncState['status']) => { for (const listener of listeners) listener({ status } as SyncState); };
	const plugin = Object.assign(fixture(), {
		syncRuntime: { addStateChangeListener: (listener: (state: SyncState) => void) => listeners.add(listener), removeStateChangeListener: (listener: (state: SyncState) => void) => listeners.delete(listener) },
		register: vi.fn(),
	});
	vi.mocked(serverRequest).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ reading: true, reminders: true, revision: 'one' });
	registerSharedFeatures(plugin as unknown as CratePlugin);
	await vi.waitFor(() => expect(serverRequest).toHaveBeenCalledOnce());
	await new Promise(resolve => setTimeout(resolve, 0));
	emit('syncing');
	emit('idle');
	await vi.waitFor(() => expect(serverRequest).toHaveBeenCalledTimes(2));
});
