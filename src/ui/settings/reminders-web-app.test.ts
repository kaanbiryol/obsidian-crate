import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, noticeMessages, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';
import { SECRET_KEYS } from '../../platform/secret-keys';

const openExternalBrowserModal = vi.fn<(app: unknown, url: string, options: { linkText: string }) => void>();

// Link building is covered in plugin/web-app-enrollment.test.ts; these cover the buttons.
async function setup(isMobile = false) {
	vi.doMock('obsidian', () => ({ ...createObsidianUiModule(), Platform: { isMobile } }));
	vi.doMock('./qr-modal', () => ({ QRModal: class {} }));
	vi.doMock('./external-browser-modal', () => ({ openExternalBrowserModal }));
	const secrets = new Map<string, string>([[SECRET_KEYS.AUTH_TOKEN, 'device-token']]);
	const api = {
		getWorkerUrl: () => 'https://crate.example',
		createRemindersEnrollmentToken: vi.fn(async () => ({ token: 'enroll', browserToken: 'browser-enroll' })),
	};
	const open = vi.fn(); vi.stubGlobal('window', { open });
	const plugin = {
		settings: { workerUrl: 'https://crate.example', pushEnabled: false, reading: { folderPath: 'Reading' } },
		remindersSettings: { remindersFolderPath: 'Reminders' },
		secretStorage: { get: (key: string) => secrets.get(key) ?? null },
		syncRuntime: { getApiClient: vi.fn(() => api) },
	};
	const { renderCrateWebApp } = await import('./reminders-web-app');
	renderCrateWebApp({ containerEl: new FakeElement('div') as never, plugin: plugin as never });
	return { api, open, plugin, button: MockSetting.instances.at(-1)!.buttons[0]! };
}

afterEach(() => {
	resetObsidianUiMocks(); vi.unstubAllGlobals(); vi.resetModules();
	vi.doUnmock('obsidian'); vi.doUnmock('./qr-modal'); vi.doUnmock('./external-browser-modal');
	openExternalBrowserModal.mockClear();
});

it('opens the web app from a fresh link tap on mobile', async () => {
	const { button, open, plugin } = await setup(true);
	button.click(); await vi.waitFor(() => expect(openExternalBrowserModal).toHaveBeenCalledOnce());
	expect(open).not.toHaveBeenCalled();
	const [app, url, options] = openExternalBrowserModal.mock.calls[0]!;
	expect(app).toBe((plugin as { app?: unknown }).app);
	expect(new URL(url).origin).toBe('https://crate.example');
	expect(options).toMatchObject({ linkText: 'Open app' });
});

it('opens no link and restores the button when the link cannot be created', async () => {
	const { button, open, plugin } = await setup();
	let finish!: () => void;
	const api = plugin.syncRuntime.getApiClient();
	api.createRemindersEnrollmentToken.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ token: 'enroll', browserToken: 'browser-enroll' }); }));
	button.click();
	await vi.waitFor(() => expect(api.createRemindersEnrollmentToken).toHaveBeenCalledOnce());
	expect(button.buttonEl.textContent).toBe('Creating...');
	plugin.remindersSettings.remindersFolderPath = 'Other';
	finish();
	await vi.waitFor(() => expect(button.buttonEl.classNames.has('is-disabled')).toBe(false));
	expect(button.buttonEl.textContent).toBe('Open app');
	expect(open).not.toHaveBeenCalled();
	expect(noticeMessages).toEqual(['Could not create app link: The connection changed. Create a new setup link.']);
});
