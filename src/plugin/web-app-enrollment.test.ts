import { expect, it, vi } from 'vitest';
import type CratePlugin from './CratePlugin';
import { buildEnrollmentUrl } from './web-app-enrollment';
import { endPluginLifecycle } from './lifecycle-state';
import { createVaultKeyBundle, generateRecoveryCode } from '../encryption/key-bundle';
import { SECRET_KEYS } from '../platform/secret-keys';

async function setup({ encrypted = false, pushEnabled = false } = {}) {
	const recovery = await generateRecoveryCode();
	const secrets = new Map<string, string>([[SECRET_KEYS.AUTH_TOKEN, 'device-token']]);
	if (encrypted) {
		secrets.set(SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(await createVaultKeyBundle()));
		secrets.set(SECRET_KEYS.ENCRYPTION_RECOVERY, recovery);
	}
	const api = {
		getWorkerUrl: () => 'https://crate.example',
		ensureNotificationPolicy: vi.fn(async (policy: object) => ({ policy })),
		createRemindersEnrollmentToken: vi.fn(async (_folder: string) => ({ token: 'install-token', browserToken: 'browser-token' })),
	};
	const plugin = {
		settings: { workerUrl: 'https://crate.example', pushEnabled, reading: { folderPath: 'Reading' } },
		remindersSettings: { remindersFolderPath: 'Reminders', upcomingDaysDefault: 7, allDayNotificationTime: '09:00' as string | null },
		secretStorage: { get: (key: string) => secrets.get(key) ?? null },
		syncRuntime: { getApiClient: vi.fn((): typeof api | null => api) },
	};
	return { plugin, api, secrets, recovery, build: () => buildEnrollmentUrl(plugin as unknown as CratePlugin) };
}

it('builds the link from the active API endpoint when persisted settings are stale', async () => {
	const { plugin, api, build } = await setup();
	plugin.settings.workerUrl = '';
	api.getWorkerUrl = () => 'https://active-worker.example.com';
	await expect(build()).resolves.toBe(
		'https://active-worker.example.com/notifications?token=install-token&browserToken=browser-token&folder=Reminders&upcomingDays=7&allDayTime=09%3A00',
	);
	expect(api.createRemindersEnrollmentToken).toHaveBeenCalledExactlyOnceWith('Reminders');
	expect(api.ensureNotificationPolicy).not.toHaveBeenCalled();
});

it('never puts the recovery key in an encrypted setup link', async () => {
	const { build, recovery } = await setup({ encrypted: true });
	const link = new URL(await build());
	const fragment = new URLSearchParams(link.hash.slice(1));
	// The fragment never reaches the server, so only it carries the folder's readable name.
	expect([...fragment.keys()]).toEqual(['crateFolder']);
	expect(fragment.get('crateFolder')).toBe('Reminders');
	expect(link.searchParams.has('folder')).toBe(false);
	expect(link.toString()).not.toContain(recovery);
});

it('preserves plaintext enrollment without including any encryption key', async () => {
	const { build } = await setup();
	const link = new URL(await build());
	expect(link.hash).toBe('');
	expect(link.searchParams.get('folder')).toBe('Reminders');
});

it('confirms the shared notification policy from this device before creating the link', async () => {
	const { plugin, api, build } = await setup({ pushEnabled: true });
	plugin.remindersSettings.allDayNotificationTime = null;
	const link = new URL(await build());
	expect(api.ensureNotificationPolicy).toHaveBeenCalledExactlyOnceWith({
		enabled: true, folderPath: 'Reminders', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, allDayTime: null,
	});
	expect(api.ensureNotificationPolicy.mock.invocationCallOrder[0]).toBeLessThan(api.createRemindersEnrollmentToken.mock.invocationCallOrder[0]!);
	expect(link.searchParams.has('allDayTime')).toBe(false);
});

it('needs a sync connection', async () => {
	const { plugin, build } = await setup();
	plugin.syncRuntime.getApiClient.mockReturnValue(null);
	await expect(build()).rejects.toThrow('Sync API is unavailable');
});

it.each(['token', 'server', 'client', 'reminders folder', 'Reading folder', 'plugin lifetime'])('returns no link after the %s changes', async change => {
	const { plugin, api, secrets, build } = await setup();
	let finish!: () => void;
	api.createRemindersEnrollmentToken.mockImplementation(() => new Promise(resolve => {
		finish = () => resolve({ token: 'install-token', browserToken: 'browser-token' });
	}));
	const link = build();
	await vi.waitFor(() => expect(api.createRemindersEnrollmentToken).toHaveBeenCalledOnce());
	if (change === 'token') secrets.set(SECRET_KEYS.AUTH_TOKEN, 'new-session');
	if (change === 'server') plugin.settings.workerUrl = 'https://other.example';
	if (change === 'client') plugin.syncRuntime.getApiClient.mockReturnValue({ ...api });
	if (change === 'reminders folder') plugin.remindersSettings.remindersFolderPath = 'Other';
	if (change === 'Reading folder') plugin.settings.reading.folderPath = 'Articles';
	if (change === 'plugin lifetime') endPluginLifecycle(plugin as unknown as CratePlugin);
	finish();
	await expect(link).rejects.toThrow();
});
