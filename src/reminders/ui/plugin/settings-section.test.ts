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
