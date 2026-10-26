import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';
import { createVaultKeyBundle, generateRecoveryCode } from '../../encryption/key-bundle';
import { SECRET_KEYS } from '../../platform/secret-keys';
import { fakeWithCurrentApi } from '../../test/fakes/sync-runtime';

const openExternalBrowserModal = vi.fn<(app: unknown, url: string, options: { linkText: string }) => void>();

async function setup(encrypted = true, isMobile = false) {
	vi.doMock('obsidian', () => ({ ...createObsidianUiModule(), Platform: { isMobile } }));
	vi.doMock('../qr-modal', () => ({ QRModal: class {} }));
	vi.doMock('../external-browser-modal', () => ({ openExternalBrowserModal }));
	const recovery = await generateRecoveryCode();
	const bundle = await createVaultKeyBundle();
	const secrets = new Map<string, string>([[SECRET_KEYS.AUTH_TOKEN, 'device-token']]);
	if (encrypted) { secrets.set(SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(bundle)); secrets.set(SECRET_KEYS.ENCRYPTION_RECOVERY, recovery); }
	const api = {
		getWorkerUrl: () => 'https://crate.example',
		createRemindersEnrollmentToken: vi.fn(async () => ({ token: 'enroll', browserToken: 'browser-enroll' })),
		serverFolder: async (folderPath: string) => ({ folderPath }),
	};
	const open = vi.fn(); vi.stubGlobal('window', { open });
	const plugin = {
		settings: { pushEnabled: false, reading: { folderPath: 'Reading' } },
		remindersSettings: { remindersFolderPath: 'Reminders' },
		secretStorage: { get: (key: string) => secrets.get(key) ?? null },
		syncRuntime: {
			getApiClient: vi.fn(() => api),
			withCurrentApi: fakeWithCurrentApi((): typeof api => plugin.syncRuntime.getApiClient()),
		},
	};
	const { renderCrateWebApp } = await import('./reminders-web-app');
	renderCrateWebApp({ containerEl: new FakeElement('div') as never, plugin: plugin as never });
	return { recovery, secrets, api, open, plugin, button: MockSetting.instances.at(-1)!.buttons[0]! };
}

afterEach(() => {
	resetObsidianUiMocks(); vi.unstubAllGlobals(); vi.resetModules();
	vi.doUnmock('obsidian'); vi.doUnmock('../qr-modal'); vi.doUnmock('../external-browser-modal');
	openExternalBrowserModal.mockClear();
});

it('opens the web app from a fresh link tap on mobile', async () => {
	const { button, open, plugin } = await setup(false, true);
	button.click(); await vi.waitFor(() => expect(openExternalBrowserModal).toHaveBeenCalledOnce());
	expect(open).not.toHaveBeenCalled();
	const [app, url, options] = openExternalBrowserModal.mock.calls[0]!;
	expect(app).toBe((plugin as { app?: unknown }).app);
	expect(new URL(url).origin).toBe('https://crate.example');
	expect(options).toMatchObject({ linkText: 'Open app' });
});

it('never puts the recovery key in an encrypted setup link', async () => {
	const { button, open, api, recovery } = await setup();
	button.click(); await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
	const link = open.mock.calls[0]![0] as string, fragment = new URLSearchParams(new URL(link).hash.slice(1));
	expect([...fragment.keys()]).toEqual(['crateFolder']);
	expect(fragment.get('crateFolder')).toBe('Reminders');
	expect(link).not.toContain(recovery);
	expect(api.createRemindersEnrollmentToken).toHaveBeenCalledWith('Reminders');
});

it.each(['token', 'folder', 'client'])('does not open a delayed link after its %s changes', async change => {
	const { button, open, api, secrets, plugin } = await setup();
	let finish!: (value: { token: string; browserToken: string }) => void;
	api.createRemindersEnrollmentToken.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
	button.click(); await vi.waitFor(() => expect(api.createRemindersEnrollmentToken).toHaveBeenCalledOnce());
	if (change === 'token') secrets.set(SECRET_KEYS.AUTH_TOKEN, 'new-session');
	if (change === 'folder') plugin.remindersSettings.remindersFolderPath = 'Other';
	if (change === 'client') plugin.syncRuntime.getApiClient.mockReturnValue({ ...api });
	finish({ token: 'enroll', browserToken: 'browser-enroll' });
	await vi.waitFor(() => expect(button.buttonEl.classNames.has('is-disabled')).toBe(false));
	expect(open).not.toHaveBeenCalled();
});

it('preserves plaintext enrollment without including any encryption key', async () => {
	const { button, open } = await setup(false);
	button.click(); await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
	expect(new URL(open.mock.calls[0]![0] as string).hash).toBe('');
});
