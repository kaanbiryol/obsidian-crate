import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, openSettingsDisclosures, createObsidianUiModule, noticeMessages, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';

const request = vi.fn();
const validate = vi.fn();
const policy = { enabled: 1, folder_path: 'Articles', generation: 'g', revision: 'r' };

beforeEach(() => {
	vi.doMock('../../ui/settings/folder-suggest', () => ({ FolderSuggest: class { close() {} } }));
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../server', () => ({ readingServerRequest: request }));
	vi.doMock('../runtime', () => ({ startReading: vi.fn(), stopReading: vi.fn(), validateReadingConfiguration: validate }));
	vi.doMock('./reading-view', () => ({ READING_VIEW_TYPE: 'crate-reading' }));
	request.mockImplementation(async (_plugin, path) => path === '/reading/fetching' ? { enabled: true, revision: 'r' } : { policy });
});
afterEach(() => {
	resetObsidianUiMocks();
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../ui/settings/folder-suggest');
	vi.doUnmock('../server');
	vi.doUnmock('../runtime');
	vi.doUnmock('./reading-view');
	request.mockReset();
	validate.mockReset();
});

async function setup(connected = true, enabled = true) {
	const plugin = {
		app: { workspace: { detachLeavesOfType: vi.fn() } },
		remindersSettings: { enabled: true },
		settings: { reading: { enabled, folderPath: 'Reading' }, workerUrl: connected ? 'https://crate.example' : '' },
		writeSettings: vi.fn(async ({ reading }: { reading: { enabled: boolean; folderPath: string } }) => { plugin.settings.reading = reading; }),
	};
	const container = Object.assign(new FakeElement('div'), { isConnected: true });
	const rerender = vi.fn();
	const { renderReadingSettings } = await import('./settings-section');
	renderReadingSettings(container as never, plugin as never, rerender);
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
 expect(plugin.settings.reading).toEqual({ enabled, folderPath: 'Reading' });
 expect(request).not.toHaveBeenCalled();
 expect(plugin.app.workspace.detachLeavesOfType).toHaveBeenCalledWith('crate-reading');
 const { startReading, stopReading } = await import('../runtime');
 expect(stopReading).toHaveBeenCalledOnce();
 expect(startReading).toHaveBeenCalledTimes(enabled ? 1 : 0);
});

it('hides preferences when Reading is disabled', async () => {
 await setup(false, false);
 expect(MockSetting.instances.map(row => row.nameEl.textContent)).toEqual(['Enable reading']);
});

it('keeps the feature enabled if saving its preference fails', async () => {
 const { plugin, toggle, rerender } = await setup(false);
 plugin.writeSettings.mockRejectedValue(new Error('Disk unavailable'));
 toggle.change(false);
 await vi.waitFor(() => expect(rerender).toHaveBeenCalled());
 expect(plugin.settings.reading.enabled).toBe(true);
 expect(noticeMessages).toContain('Disk unavailable');
});
