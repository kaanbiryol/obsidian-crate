import { DEFAULT_SETTINGS } from '../../plugin/settings-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, MockTextComponent, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';

async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
	resetObsidianUiMocks();
	vi.doMock('obsidian', () => createObsidianUiModule());
});
afterEach(() => {
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('./folder-suggest');
	vi.doUnmock('./reminders-web-app');
});

describe('settings controls', () => {
	it('provides one debug toggle for both logging systems', async () => {
		const { renderTroubleshootingSettings } = await import('./troubleshooting-section');
		const plugin = {
			settings: { deviceId: 'device-test', debugLogging: false },
			setDebugLogging: vi.fn(async (enabled: boolean) => { plugin.settings.debugLogging = enabled; }),
		};
		renderTroubleshootingSettings(new FakeElement('div') as never, plugin as never);
		const loggingSettings = MockSetting.instances.filter(setting => setting.toggles.length);
		expect(loggingSettings).toHaveLength(1);
		expect(loggingSettings[0]!.nameEl.textContent).toBe('Debug logging');
		const toggle = loggingSettings[0]!.toggles[0]!;
		toggle.change(true);
		expect(toggle.disabled).toBe(true);
		await flush();
		expect(plugin.setDebugLogging).toHaveBeenCalledWith(true);
		expect(toggle.value).toBe(true);
		expect(toggle.disabled).toBe(false);
	});

	it('keeps custom intervals and does not save when Custom is selected', async () => {
		const { renderSyncInterval } = await import('./sync-interval');
		let interval = 120;
		const save = vi.fn(async (value: number) => { interval = value; });
		renderSyncInterval(new FakeElement('div') as never, () => interval, save);
		const setting = MockSetting.instances[0]!;
		const dropdown = setting.dropdowns[0]!;
		const input = setting.texts[0]!;
		expect(dropdown.value).toBe('custom');
		expect(input.inputEl.value).toBe('120');
		await dropdown.change('custom');
		expect(save).not.toHaveBeenCalled();
		await dropdown.change('300');
		expect(interval).toBe(300);
		expect(input.inputEl.hidden).toBe(true);
		await dropdown.change('custom');
		input.change('75');
		expect(interval).toBe(300);
		input.inputEl.blur();
		await flush();
		expect(interval).toBe(75);
	});

	it('restores the previous interval after a failed preset change', async () => {
		const { renderSyncInterval } = await import('./sync-interval');
		renderSyncInterval(new FakeElement('div') as never, () => 120, async () => { throw new Error('offline'); });
		const setting = MockSetting.instances[0]!;
		await setting.dropdowns[0]!.change('300');
		expect(setting.dropdowns[0]!.value).toBe('custom');
		expect(setting.dropdowns[0]!.disabled).toBe(false);
		expect(setting.texts[0]!.inputEl.hidden).toBe(false);
		expect(setting.texts[0]!.inputEl.value).toBe('120');
	});

	it('validates complete numeric values and restores the stored value after a failed save', async () => {
		const { bindCommittedText, parseSettingInteger } = await import('./input-helpers');
		for (const invalid of ['', '10abc', '1.5', '-1', 'Infinity', '9007199254740992']) {
			expect(parseSettingInteger(invalid, 0)).toBeNull();
		}
		expect(parseSettingInteger('0', 0)).toBe(0);
		expect(parseSettingInteger('0', 1)).toBeNull();
		expect(parseSettingInteger('30', 0, 20)).toBeNull();
		const text = new MockTextComponent().setValue('5');
		const save = vi.fn(async () => { throw new Error('disk full'); });
		bindCommittedText(text as never, () => '5', save, value => parseSettingInteger(value, 0) !== null);
		text.change('12');
		expect(save).not.toHaveBeenCalled();
		text.inputEl.blur();
		await flush();
		expect(text.inputEl.value).toBe('5');
		expect(text.inputEl.disabled).toBe(false);
	});

	it('previews folder and wildcard exclusions and saves only complete drafts', async () => {
		const { renderExclusionsSetting } = await import('./exclusions-setting');
		const plugin = {
			settings: { ignorePatterns: [] as string[] },
			app: { vault: { getFiles: () => [{ path: 'Archive/a.md' }, { path: 'a.tmp' }, { path: 'b.md' }] } },
		};
		const save = vi.fn(async (value: string[]) => { plugin.settings.ignorePatterns = value; });
		const container = new FakeElement('div');
		renderExclusionsSetting(container as never, plugin as never, save);
		const text = MockSetting.instances[0]!.texts[0]!;
		text.change('Archive/\n*.tmp');
		expect(save).not.toHaveBeenCalled();
		MockSetting.instances[1]!.buttons[0]!.click();
		expect(container.collectText()).toContain('2 matching files');
		expect(container.collectText()).toContain('Archive/a.md');
		expect(container.collectText()).not.toContain('b.md');
		text.inputEl.blur();
		await flush();
		expect(save).toHaveBeenCalledExactlyOnceWith(['Archive/', '*.tmp']);
	});

	it('shows sync preferences without manual sync actions or progress subscriptions', async () => {
		const { renderSyncSection } = await import('./sync-section');
		const plugin = { settings: { ...DEFAULT_SETTINGS } };
		renderSyncSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
		const names = MockSetting.instances.map(setting => setting.nameEl.textContent);
		expect(names).not.toContain('Sync now');
		expect(names).not.toContain('Sync activity');
		const delay = MockSetting.instances.find(setting => setting.nameEl.textContent === 'Sync delay after editing (seconds)')!;
		expect(delay.texts[0]!.inputEl.value).toBe('5');
	});

	it('uses a startup toggle and preserves the saved reminder defaults', async () => {
		vi.doMock('./folder-suggest', () => ({ RemindersFolderSuggest: class { close() {} } }));
		vi.doMock('./reminders-web-app', () => ({ renderRemindersWebApp: vi.fn() }));
		const { renderRemindersSection } = await import('./reminders-section');
		const plugin = {
			app: {},
			remindersSettings: { enabled: true, autoOpenView: 'sidebar', sidebarDefaultTab: 'today', upcomingDaysDefault: 7, remindersFolderPath: 'Reminders', taskCreationDefaultDueDate: 'none' },
			writeRemindersSettings: vi.fn(async () => {}),
		};
		renderRemindersSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
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
});
