import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../../test/fakes/obsidian-ui';

async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
	resetObsidianUiMocks();
	vi.doMock('obsidian', () => ({ ...createObsidianUiModule(), Platform: { isMobile: false } }));
});
afterEach(() => {
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../../ui/settings/folder-suggest');
});

it('uses a startup toggle and preserves the saved reminder defaults', async () => {
	vi.doMock('../../../ui/settings/folder-suggest', () => ({ FolderSuggest: class { close() {} } }));
	const { renderRemindersSettings } = await import('./settings-section');
	const plugin = {
		app: {},
		remindersSettings: { enabled: true, listStyle: 'flat', autoOpenView: 'sidebar', sidebarDefaultTab: 'today', upcomingDaysDefault: 7, remindersFolderPath: 'Reminders', taskCreationDefaultDueDate: 'none' },
		writeRemindersSettings: vi.fn(async () => {}),
	};
	renderRemindersSettings({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
	const startup = MockSetting.instances.find(setting => setting.nameEl.textContent === 'Open reminders on startup')!;
	expect(startup.dropdowns).toHaveLength(0);
	expect(startup.toggles[0]!.value).toBe(true);
	startup.toggles[0]!.change(false);
	await flush();
	expect(plugin.writeRemindersSettings).toHaveBeenCalledWith({ autoOpenView: 'none' });
	const tab = MockSetting.instances.find(setting => setting.nameEl.textContent === 'Default reminders tab')!;
	expect(tab.dropdowns[0]!.value).toBe('today');
	expect(MockSetting.instances.some(setting => setting.nameEl.textContent === 'Reminders debug logging')).toBe(false);
});

it('changes no notes until this vault confirms turning reminders on with their folder', async () => {
	vi.doMock('../../../ui/settings/folder-suggest', () => ({ FolderSuggest: class { close() {} } }));
	const confirm = vi.fn(async (_app: unknown, _options: { message: string }) => false);
	vi.doMock('../../../ui/confirmation-modal', () => ({ openConfirmationModal: confirm }));
	const setRemindersEnabled = vi.fn(async (target: { remindersSettings: { enabled: boolean } }, enabled: boolean) => { target.remindersSettings.enabled = enabled; });
	vi.doMock('../../plugin-integration', () => ({ setRemindersEnabled }));
	try {
		const { renderRemindersSettings } = await import('./settings-section');
		const plugin = {
			app: {},
			settings: { workerUrl: '', reading: { enabled: false, confirmed: false, folderPath: 'Reading' } },
			secretStorage: { get: () => null },
			remindersSettings: { enabled: false, confirmed: false, remindersFolderPath: 'Tasks' },
			writeRemindersSettings: vi.fn(async (update: object) => { Object.assign(plugin.remindersSettings, update); }),
		};
		const rerender = vi.fn();
		renderRemindersSettings({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender });
		// The folder can be chosen before turning reminders on; device preferences wait.
		expect(MockSetting.instances.map(setting => setting.nameEl.textContent)).toEqual(['Enable reminders', 'Reminders folder']);
		const toggle = MockSetting.instances[0]!.toggles[0]!;

		toggle.change(true);
		await vi.waitFor(() => expect(rerender).toHaveBeenCalledOnce());
		expect(confirm.mock.calls[0]![1].message).toContain('"Tasks"');
		expect(plugin.writeRemindersSettings).not.toHaveBeenCalled();
		expect(setRemindersEnabled).not.toHaveBeenCalled();

		confirm.mockResolvedValueOnce(true);
		toggle.change(true);
		await vi.waitFor(() => expect(rerender).toHaveBeenCalledTimes(2));
		expect(plugin.writeRemindersSettings).toHaveBeenCalledWith({ confirmed: true }, expect.any(Function));
		expect(setRemindersEnabled).toHaveBeenCalledWith(plugin, true, expect.any(Function));
		expect(plugin.remindersSettings).toMatchObject({ enabled: true, confirmed: true });
	} finally {
		vi.doUnmock('../../../ui/confirmation-modal');
		vi.doUnmock('../../plugin-integration');
	}
});
