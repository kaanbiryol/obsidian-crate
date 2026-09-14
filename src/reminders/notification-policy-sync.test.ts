import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CratePlugin from '../plugin/CratePlugin';
import { normalizeCrateSettings } from '../plugin/settings';
import { DEFAULT_REMINDERS_SETTINGS, useRemindersSettingsStore } from './settings';
import { changeReminderFolder, ensureReminderNotificationPolicy, refreshReminderNotificationPolicy } from './notification-policy-sync';
import { beginPluginLifecycle } from '../plugin/lifecycle-state';

vi.mock('../plugin/lifecycle', () => ({ bootstrapPlugin: vi.fn(), shutdownPlugin: vi.fn() }));
vi.mock('./plugin-integration', () => ({ initializeReminders: vi.fn(), reinitializeReminders: vi.fn() }));
vi.mock('./ui/workspaceLayout', () => ({ activateOrRevealRemindersLeaf: vi.fn() }));
beforeEach(() => useRemindersSettingsStore.setState({ ...DEFAULT_REMINDERS_SETTINGS, enabled: true }, true));
afterEach(() => vi.restoreAllMocks());

function harness() {
	let data: unknown;
	let online = true;
	let policy = { folderPath: 'Reminders', enabled: false, timezone: 'Europe/Berlin', allDayTime: '08:30', revision: 'first' };
	const ensureNotificationPolicy = vi.fn(async () => {
		if (!online) throw new Error('offline');
		return { policy: { ...policy } };
	});
	const updateNotificationPolicy = vi.fn(async (next: typeof policy) => {
		if (!online) throw new Error('offline');
		policy = { ...next, revision: crypto.randomUUID() };
		return { policy };
	});
	const api = { ensureNotificationPolicy, updateNotificationPolicy };
	const getApiClient = vi.fn(() => api);
	const plugin = new CratePlugin({} as never, {} as never);
	const saveData = vi.fn(async (next: unknown) => { data = structuredClone(next); });
	const reinitializeWithFolder = vi.fn(async () => {});
	Object.assign(plugin, { app: { vault: { configDir: '.obsidian' } },
		settings: normalizeCrateSettings({ workerUrl: 'https://first.example' }, '.obsidian'),
		syncRuntime: { getApiClient }, saveData, loadData: async () => data,
		reinitializeWithFolder });
	return { plugin, api, getApiClient, saveData, reinitializeWithFolder, ensureNotificationPolicy, updateNotificationPolicy,
		setOnline: (value: boolean) => { online = value; }, policy: () => policy };
}

it('saves and applies an offline edit, then retries its persisted intent after reload', async () => {
	const h = harness(); h.setOnline(false);
	await changeReminderFolder(h.plugin, ' /Tasks/Work/ ');
	await ensureReminderNotificationPolicy(h.plugin);
	expect(h.plugin.remindersSettings.remindersFolderPath).toBe('Tasks/Work');
	expect(h.reinitializeWithFolder).toHaveBeenCalledWith('Tasks/Work');
	expect(h.plugin.remindersSettings.pendingServerFolder).toMatchObject({ folderPath: 'Tasks/Work', workerUrl: 'https://first.example' });
	useRemindersSettingsStore.setState(DEFAULT_REMINDERS_SETTINGS, true);
	await h.plugin.loadSettings(); h.setOnline(true);
	await ensureReminderNotificationPolicy(h.plugin, true);
	expect(h.policy()).toMatchObject({ folderPath: 'Tasks/Work', enabled: false, timezone: 'Europe/Berlin', allDayTime: '08:30' });
	expect(h.plugin.remindersSettings.pendingServerFolder).toBeUndefined();
	await h.plugin.loadSettings();
	expect(h.plugin.remindersSettings.pendingServerFolder).toBeUndefined();
});

it('confirms unchanged settings once across concurrent, periodic, and strict initial-completion checks', async () => {
	const h = harness();
	await Promise.all([ensureReminderNotificationPolicy(h.plugin), ensureReminderNotificationPolicy(h.plugin, true)]);
	for (let i = 0; i < 10; i++) await ensureReminderNotificationPolicy(h.plugin, true);
	await h.plugin.writeRemindersSettings({ upcomingDaysDefault: 14 });
	await ensureReminderNotificationPolicy(h.plugin);
	expect(h.ensureNotificationPolicy).toHaveBeenCalledOnce();
	expect(h.updateNotificationPolicy).not.toHaveBeenCalled();
});

it.each(['folder', 'enabled', 'all-day time', 'timezone'])('checks again when the %s setting changes', async setting => {
	const h = harness();
	await ensureReminderNotificationPolicy(h.plugin, true);
	if (setting === 'folder') await changeReminderFolder(h.plugin, 'Tasks');
	if (setting === 'enabled') h.plugin.settings.pushEnabled = !h.plugin.settings.pushEnabled;
	if (setting === 'all-day time') await h.plugin.writeRemindersSettings({ allDayNotificationTime: '13:45' });
	if (setting === 'timezone') {
		const options = new Intl.DateTimeFormat().resolvedOptions();
		vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options,
			timeZone: options.timeZone === 'Pacific/Auckland' ? 'UTC' : 'Pacific/Auckland' });
	}
	await ensureReminderNotificationPolicy(h.plugin, true);
	await ensureReminderNotificationPolicy(h.plugin, true);
	expect(h.ensureNotificationPolicy).toHaveBeenCalledTimes(2);
	if (setting === 'folder') expect(h.policy().folderPath).toBe('Tasks');
});

it('retries a failed folder update even when its folder matches an earlier confirmation', async () => {
	const h = harness();
	await ensureReminderNotificationPolicy(h.plugin, true);
	await h.updateNotificationPolicy({ ...h.policy(), folderPath: 'ChangedElsewhere' });
	h.setOnline(false);
	await changeReminderFolder(h.plugin, 'Reminders');
	await ensureReminderNotificationPolicy(h.plugin);
	expect(h.plugin.remindersSettings.pendingServerFolder).toBeDefined();
	h.setOnline(true);
	await ensureReminderNotificationPolicy(h.plugin, true);
	expect(h.policy().folderPath).toBe('Reminders');
	expect(h.plugin.remindersSettings.pendingServerFolder).toBeUndefined();
	h.ensureNotificationPolicy.mockClear();
	await ensureReminderNotificationPolicy(h.plugin, true);
	expect(h.ensureNotificationPolicy).not.toHaveBeenCalled();
});

it.each(['reconnect', 'API replacement', 'server change', 'plugin restart'])('checks again after %s', async reason => {
	const h = harness();
	await ensureReminderNotificationPolicy(h.plugin, true);
	if (reason === 'reconnect') await refreshReminderNotificationPolicy(h.plugin);
	if (reason === 'API replacement') h.getApiClient.mockReturnValue({ ...h.api });
	if (reason === 'server change') h.plugin.settings.workerUrl = 'https://second.example';
	if (reason === 'plugin restart') beginPluginLifecycle(h.plugin);
	await ensureReminderNotificationPolicy(h.plugin, true);
	await ensureReminderNotificationPolicy(h.plugin, true);
	expect(h.ensureNotificationPolicy).toHaveBeenCalledTimes(2);
});

it('checks settings changed while an earlier confirmation is still in flight', async () => {
	const h = harness();
	let release!: () => void;
	h.ensureNotificationPolicy.mockImplementationOnce(async () => {
		await new Promise<void>(resolve => { release = resolve; });
		return { policy: h.policy() };
	});
	const first = ensureReminderNotificationPolicy(h.plugin, true);
	h.plugin.settings.pushEnabled = true;
	const latest = ensureReminderNotificationPolicy(h.plugin, true);
	release(); await Promise.all([first, latest]);
	expect(h.ensureNotificationPolicy).toHaveBeenCalledTimes(2);
	expect(h.ensureNotificationPolicy).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
	await ensureReminderNotificationPolicy(h.plugin, true);
	expect(h.ensureNotificationPolicy).toHaveBeenCalledTimes(2);
});

it('does not use a late pre-reconnect response to confirm the new connection', async () => {
	const h = harness();
	let releaseOld!: () => void;
	let releaseNew!: () => void;
	h.ensureNotificationPolicy.mockImplementationOnce(async () => {
		await new Promise<void>(resolve => { releaseOld = resolve; });
		return { policy: h.policy() };
	}).mockImplementationOnce(async () => {
		await new Promise<void>(resolve => { releaseNew = resolve; });
		return { policy: h.policy() };
	});
	let completed = false;
	const old = ensureReminderNotificationPolicy(h.plugin, true).then(() => { completed = true; });
	const fresh = refreshReminderNotificationPolicy(h.plugin);
	releaseOld();
	await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
	expect(completed).toBe(false);
	releaseNew(); await Promise.all([old, fresh]);
	await ensureReminderNotificationPolicy(h.plugin, true);
	expect(h.ensureNotificationPolicy).toHaveBeenCalledTimes(2);
});

it('does not send a folder change if the local save fails', async () => {
	const h = harness(); h.saveData.mockRejectedValueOnce(new Error('disk full'));
	await expect(changeReminderFolder(h.plugin, 'Tasks')).rejects.toThrow('disk full');
	expect(h.plugin.remindersSettings.remindersFolderPath).toBe('Reminders');
	expect(h.ensureNotificationPolicy).not.toHaveBeenCalled();
});

it('keeps a newer edit when an older server response arrives', async () => {
	const h = harness();
	let release!: () => void;
	h.updateNotificationPolicy.mockImplementationOnce(async next => {
		await new Promise<void>(resolve => { release = resolve; });
		return { policy: next };
	});
	await changeReminderFolder(h.plugin, 'First');
	await vi.waitFor(() => expect(h.updateNotificationPolicy).toHaveBeenCalledOnce());
	await changeReminderFolder(h.plugin, 'Second');
	release(); await ensureReminderNotificationPolicy(h.plugin, true);
	expect(h.policy().folderPath).toBe('Second');
	expect(h.plugin.remindersSettings.remindersFolderPath).toBe('Second');
	expect(h.plugin.remindersSettings.pendingServerFolder).toBeUndefined();
});

it('does not carry a queued edit to another server or overwrite policy without an explicit edit', async () => {
	const h = harness(); h.setOnline(false);
	await changeReminderFolder(h.plugin, 'Tasks'); await ensureReminderNotificationPolicy(h.plugin);
	h.setOnline(true); h.plugin.settings.workerUrl = 'https://second.example';
	await ensureReminderNotificationPolicy(h.plugin, true);
	expect(h.updateNotificationPolicy).not.toHaveBeenCalled();
	expect(h.plugin.remindersSettings.pendingServerFolder?.workerUrl).toBe('https://first.example');
});

it('acknowledges a lost successful update without creating another server revision', async () => {
	const h = harness(); h.setOnline(false);
	await changeReminderFolder(h.plugin, 'Tasks'); await ensureReminderNotificationPolicy(h.plugin);
	h.setOnline(true);
	await h.updateNotificationPolicy({ ...h.policy(), folderPath: 'Tasks' });
	h.updateNotificationPolicy.mockClear();
	await ensureReminderNotificationPolicy(h.plugin, true);
	expect(h.updateNotificationPolicy).not.toHaveBeenCalled();
	expect(h.plugin.remindersSettings.pendingServerFolder).toBeUndefined();
});
