import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode } from '../../encryption/key-bundle';
import { SECRET_KEYS } from '../../plugin/settings-types';

async function setup(encrypted = true) {
  vi.doMock('obsidian', () => createObsidianUiModule());
  vi.doMock('../qr-modal', () => ({ QRModal: class {} }));
  const recovery = await generateRecoveryCode();
  const bundle = addReminderScope(addReminderScope(createVaultKeyBundle(), 'Reminders'), 'Reading', 'reading');
  const secrets = new Map<string, string>([[SECRET_KEYS.AUTH_TOKEN, 'device-token']]);
  if (encrypted) { secrets.set(SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(bundle)); secrets.set(SECRET_KEYS.ENCRYPTION_RECOVERY, recovery); }
  const api = {
    getWorkerUrl: () => 'https://crate.example',
    createRemindersEnrollmentToken: vi.fn(async () => ({ token: 'enroll', browserToken: 'browser-enroll' })),
  };
  const open = vi.fn(); vi.stubGlobal('window', { open });
  const plugin = {
    settings: { pushEnabled: false, reading: { folderPath: 'Reading' } },
    remindersSettings: { remindersFolderPath: 'Reminders' },
    secretStorage: { get: (key: string) => secrets.get(key) ?? null },
    syncRuntime: { getApiClient: vi.fn(() => api) },
  };
  const { renderCrateWebApp } = await import('./reminders-web-app');
  renderCrateWebApp(new FakeElement('div') as never, plugin as never);
  return { recovery, secrets, api, open, plugin, button: MockSetting.instances.at(-1)!.buttons[0]! };
}

afterEach(() => {
  resetObsidianUiMocks(); vi.unstubAllGlobals(); vi.resetModules();
  vi.doUnmock('obsidian'); vi.doUnmock('../qr-modal');
});

it('shares the same recovery code through fragments without sending it to enrollment APIs', async () => {
  const { button, open, api, recovery } = await setup();
  button.click(); await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  const url = new URL(open.mock.calls[0]![0] as string), fragment = new URLSearchParams(url.hash.slice(1));
  expect(fragment.get('crateKey')).toBe(recovery);
  expect(fragment.get('crateReadingKey')).toBe(recovery);
  expect(url.search).not.toContain(recovery);
  expect(api.createRemindersEnrollmentToken).toHaveBeenCalledWith('Reminders');
});

it('does not create an encrypted enrollment before the recovery key is available', async () => {
  const { button, open, api, secrets } = await setup();
  secrets.delete(SECRET_KEYS.ENCRYPTION_RECOVERY);
  button.click(); await vi.waitFor(() => expect(button.buttonEl.classNames.has('is-disabled')).toBe(false));
  expect(api.createRemindersEnrollmentToken).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it.each(['token', 'recovery', 'folder', 'client'])('does not expose a recovery key in a delayed link after its %s changes', async change => {
  const { button, open, api, secrets, plugin } = await setup();
  let finish!: (value: { token: string; browserToken: string }) => void;
  api.createRemindersEnrollmentToken.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  button.click(); await vi.waitFor(() => expect(api.createRemindersEnrollmentToken).toHaveBeenCalledOnce());
  if (change === 'token') secrets.set(SECRET_KEYS.AUTH_TOKEN, 'new-session');
  if (change === 'recovery') secrets.set(SECRET_KEYS.ENCRYPTION_RECOVERY, 'different-key');
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
