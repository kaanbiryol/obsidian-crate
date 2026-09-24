import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';

const readingServerRequest = vi.fn(async (_plugin: unknown, path: string) => path === '/reading/access'
	? { url: 'https://worker.example.com/reading?token=short-lived' }
	: { policy: null });
const openExternalBrowserModal = vi.fn();

afterEach(() => {
	resetObsidianUiMocks();
	vi.unstubAllGlobals();
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('../server');
	vi.doUnmock('../../ui/external-browser-modal');
	vi.doUnmock('../../ui/settings/input-helpers');
	vi.doUnmock('../runtime');
	vi.doUnmock('../register-integrations');
	vi.doUnmock('./reading-view');
	vi.doUnmock('./phone-setup');
	readingServerRequest.mockClear();
	openExternalBrowserModal.mockClear();
});

it('offers tappable and selectable web reading links on mobile after obtaining access', async () => {
	vi.doMock('obsidian', () => ({ ...createObsidianUiModule(), Platform: { isMobile: true } }));
	vi.doMock('../server', () => ({ readingServerRequest }));
	vi.doMock('../../ui/external-browser-modal', () => ({ openExternalBrowserModal }));
	vi.doMock('../../ui/settings/input-helpers', () => ({ bindCommittedText: vi.fn() }));
	vi.doMock('../runtime', () => ({ startReading: vi.fn(), stopReading: vi.fn(), validateReadingConfiguration: vi.fn() }));
	vi.doMock('../register-integrations', () => ({ openReading: vi.fn() }));
	vi.doMock('./reading-view', () => ({ READING_VIEW_TYPE: 'crate-reading' }));
	vi.doMock('./phone-setup', () => ({ ReadingPhoneSetup: class ReadingPhoneSetup {} }));
	const openWindow = vi.fn();
	vi.stubGlobal('window', { open: openWindow });
	const { renderReadingSettings } = await import('./settings-section');
	const plugin = { app: {}, settings: { reading: { enabled: false, folderPath: 'Reading' }, workerUrl: 'https://worker.example.com' } };
	renderReadingSettings(new FakeElement('div') as never, plugin as never, vi.fn());
	const setting = MockSetting.instances.find(item => item.nameEl.textContent === 'Reading on the web');
	setting?.buttons[0]?.click();
	await vi.waitFor(() => expect(openExternalBrowserModal).toHaveBeenCalledOnce());
	expect(openExternalBrowserModal).toHaveBeenCalledWith(plugin.app,
		'https://worker.example.com/reading?token=short-lived', expect.objectContaining({ linkText: 'Open reading' }));
	expect(openWindow).not.toHaveBeenCalled();

	vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Clipboard denied')) } });
	setting?.buttons[1]?.click();
	await vi.waitFor(() => expect(openExternalBrowserModal).toHaveBeenCalledTimes(2));
	expect(openExternalBrowserModal).toHaveBeenLastCalledWith(plugin.app,
		'https://worker.example.com/reading?token=short-lived', expect.objectContaining({ showCopyableUrl: true }));
});
