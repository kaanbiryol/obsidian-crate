import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, openSettingsDisclosures, createObsidianUiModule, noticeMessages, resetObsidianUiMocks } from '../../../test/fakes/obsidian-ui';

const request = vi.fn();
const changeReadingFolder = vi.fn();
const confirm = vi.fn(async (_app: unknown, _options: { message: string }) => true);
const policy = { enabled: 1, folder_path: 'Articles', generation: 'g', revision: 'r' };

beforeEach(() => {
	vi.doMock('../../../ui/settings/folder-suggest', () => ({ FolderSuggest: class { close() {} } }));
	vi.doMock('obsidian', () => ({ ...createObsidianUiModule(), Platform: { isDesktopApp: true } }));
	vi.doMock('../../../plugin/server-request', async () => ({ ...await vi.importActual<typeof import('../../../plugin/server-request')>('../../../plugin/server-request'), serverRequest: request }));
	vi.doMock('../../runtime', () => ({ restartReading: vi.fn(), changeReadingFolder }));
	vi.doMock('../../../ui/plugin/confirmation-modal', () => ({ openConfirmationModal: confirm }));
	request.mockImplementation(async () => ({ policy }));
});
afterEach(() => {
	resetObsidianUiMocks();
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../ui/settings/folder-suggest');
	vi.doUnmock('../../../plugin/server-request');
	vi.doUnmock('../runtime');
	vi.doUnmock('../../../ui/plugin/confirmation-modal');
	request.mockReset();
	confirm.mockClear();
	changeReadingFolder.mockReset();
});

async function setup(connected = true, enabled = true, confirmed = true) {
	const plugin = {
		app: { workspace: { detachLeavesOfType: vi.fn() } },
		syncRuntime: { getApiClient: () => null },
		remindersSettings: { enabled: true, confirmed: true },
		secretStorage: { get: (key: string) => key === 'crate-auth-token' ? 'synthetic' : null },
		settings: { reading: { enabled, folderPath: 'Reading', confirmed }, workerUrl: connected ? 'https://crate.example' : '' },
		writeSettings: vi.fn(async ({ reading }: { reading: { enabled: boolean; folderPath: string; confirmed: boolean } }) => { plugin.settings.reading = reading; }),
	};
	const container = Object.assign(new FakeElement('div'), { isConnected: true });
	const rerender = vi.fn();
	const { renderReadingSettings } = await import('./settings-section');
	renderReadingSettings({ containerEl: container as never, plugin: plugin as never, rerender });
	expect(request).not.toHaveBeenCalled();
	openSettingsDisclosures(container);
	await new Promise(resolve => setTimeout(resolve, 0));
	const toggle = MockSetting.instances.find(row => row.nameEl.textContent === 'Enable reading')!.toggles[0]!;
	return { plugin, toggle, rerender };
}


it('shows Reading controls after expanding without fetching remote settings', async () => {
 const { toggle } = await setup();
 expect(MockSetting.instances.map(row => row.nameEl.textContent)).toEqual(['Enable reading', 'Reading folder']);
 expect(toggle.value).toBe(true);
 expect(request).not.toHaveBeenCalled();
});

it.each([true, false])('sets local Reading to %s without changing another device', async enabled => {
 const { plugin, toggle, rerender } = await setup(false, !enabled);
 toggle.change(enabled);
 await vi.waitFor(() => expect(rerender).toHaveBeenCalled());
 expect(plugin.settings.reading).toEqual({ enabled, folderPath: 'Reading', confirmed: true });
 expect(request).not.toHaveBeenCalled();
 expect(confirm).not.toHaveBeenCalled();
 const { restartReading } = await import('../../runtime');
 expect(restartReading).toHaveBeenCalledExactlyOnceWith(plugin, enabled);
});

it('shows the folder while Reading is off, so it can be chosen before turning it on', async () => {
 await setup(false, false, false);
 expect(MockSetting.instances.map(row => row.nameEl.textContent)).toEqual(['Enable reading', 'Reading folder']);
});

it('changes no notes until this vault confirms turning Reading on with its folder', async () => {
 const { plugin, toggle, rerender } = await setup(false, false, false);
 confirm.mockResolvedValueOnce(false);
 toggle.change(true);
 await vi.waitFor(() => expect(rerender).toHaveBeenCalled());
 expect(confirm.mock.calls[0]![1].message).toContain('"Reading"');
 expect(plugin.writeSettings).not.toHaveBeenCalled();
 const { restartReading } = await import('../../runtime');
 expect(restartReading).not.toHaveBeenCalled();

 toggle.change(true);
 await vi.waitFor(() => expect(restartReading).toHaveBeenCalledExactlyOnceWith(plugin, true));
 expect(plugin.settings.reading).toEqual({ enabled: true, folderPath: 'Reading', confirmed: true });
});

it('names the folder from the server when a connected vault turns Reading on', async () => {
 const { plugin, toggle, rerender } = await setup(true, false, false);
 confirm.mockResolvedValueOnce(false);
 toggle.change(true);
 await vi.waitFor(() => expect(rerender).toHaveBeenCalled());
 expect(request).toHaveBeenCalledExactlyOnceWith(plugin, '/reading/policy');
 expect(confirm.mock.calls[0]![1].message).toContain('"Articles"');
 expect(plugin.writeSettings).not.toHaveBeenCalled();
});

it('keeps the feature enabled if saving its preference fails', async () => {
 const { plugin, toggle, rerender } = await setup(false);
 plugin.writeSettings.mockRejectedValue(new Error('Disk unavailable'));
 toggle.change(false);
 await vi.waitFor(() => expect(rerender).toHaveBeenCalled());
 expect(plugin.settings.reading.enabled).toBe(true);
 expect(noticeMessages).toContain('Disk unavailable');
});

// The folder change sequence itself is covered with changeReadingFolder in reading/runtime.test.ts.
it('commits the Reading folder through the shared folder change and shows why one fails', async () => {
 const { plugin, rerender } = await setup();
 const folder = MockSetting.instances.find(row => row.nameEl.textContent === 'Reading folder')!.texts[0]!;
 changeReadingFolder.mockImplementationOnce(async (_plugin: unknown, folderPath: string) => { plugin.settings.reading = { ...plugin.settings.reading, folderPath }; });
 folder.inputEl.value = 'New reading';
 folder.inputEl.blur();
 await vi.waitFor(() => expect(rerender).toHaveBeenCalledOnce());
 expect(changeReadingFolder).toHaveBeenCalledExactlyOnceWith(plugin, 'New reading');
 expect(folder.inputEl.value).toBe('New reading');

 changeReadingFolder.mockRejectedValueOnce(new Error('The server connection changed. Reopen settings and try again.'));
 folder.inputEl.value = 'Other';
 folder.inputEl.blur();
 await vi.waitFor(() => expect(noticeMessages).toContain('The server connection changed. Reopen settings and try again.'));
 expect(folder.inputEl).toMatchObject({ value: 'New reading', disabled: false });
 expect(rerender).toHaveBeenCalledOnce();
});
