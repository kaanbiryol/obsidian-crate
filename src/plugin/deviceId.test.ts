import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensurePluginDeviceId, setPluginDeviceId } from './deviceId';
import { SECRET_KEYS } from './types';

function createPlugin(options?: {
	settingsDeviceId?: string;
	secrets?: Record<string, string | null>;
}): {
	settings: { deviceId: string };
	secretStorage: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
		has: ReturnType<typeof vi.fn>;
	};
	saveSettings: ReturnType<typeof vi.fn>;
} {
	const secrets = new Map<string, string>();
	for (const [key, value] of Object.entries(options?.secrets ?? {})) {
		if (value) {
			secrets.set(key, value);
		}
	}

	return {
		settings: {
			deviceId: options?.settingsDeviceId ?? '',
		},
		secretStorage: {
			get: vi.fn((key: string) => secrets.get(key) ?? null),
			set: vi.fn((key: string, value: string) => {
				if (value) {
					secrets.set(key, value);
				} else {
					secrets.delete(key);
				}
			}),
			delete: vi.fn((key: string) => {
				secrets.delete(key);
			}),
			has: vi.fn((key: string) => secrets.has(key)),
		},
		saveSettings: vi.fn(async () => {}),
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe('ensurePluginDeviceId', () => {
	it('hydrates the runtime deviceId from local secret storage without re-saving settings', async () => {
		const plugin = createPlugin({
			secrets: {
				[SECRET_KEYS.DEVICE_ID]: 'device-local',
			},
		});

		await ensurePluginDeviceId(plugin as never);

		expect(plugin.settings.deviceId).toBe('device-local');
		expect(plugin.saveSettings).not.toHaveBeenCalled();
	});

	it('migrates a configured legacy deviceId into local secret storage when auth is already present', async () => {
		const plugin = createPlugin({
			settingsDeviceId: 'device-legacy',
			secrets: {
				[SECRET_KEYS.AUTH_TOKEN]: 'auth-token',
			},
		});

		await ensurePluginDeviceId(plugin as never);

		expect(plugin.secretStorage.set).toHaveBeenCalledWith(SECRET_KEYS.DEVICE_ID, 'device-legacy');
		expect(plugin.settings.deviceId).toBe('device-legacy');
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
	});

	it('generates a fresh local deviceId when copied settings exist without local auth state', async () => {
		vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
			array.set([0, 1, 2, 3, 4, 5, 6, 7]);
			return array;
		}) as typeof crypto.getRandomValues);
		const plugin = createPlugin({
			settingsDeviceId: 'device-zmhf',
		});

		await ensurePluginDeviceId(plugin as never);

		expect(plugin.settings.deviceId).toBe('device-abcdefgh');
		expect(plugin.secretStorage.set).toHaveBeenCalledWith(SECRET_KEYS.DEVICE_ID, 'device-abcdefgh');
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
	});
});

describe('setPluginDeviceId', () => {
	it('writes the edited deviceId into local secret storage', async () => {
		const plugin = createPlugin();

		await setPluginDeviceId(plugin as never, '  device-manual  ');

		expect(plugin.secretStorage.set).toHaveBeenCalledWith(SECRET_KEYS.DEVICE_ID, 'device-manual');
		expect(plugin.settings.deviceId).toBe('device-manual');
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
	});

	it('removes the local secret when the deviceId field is cleared', async () => {
		const plugin = createPlugin({
			secrets: {
				[SECRET_KEYS.DEVICE_ID]: 'device-existing',
			},
		});

		await setPluginDeviceId(plugin as never, '   ');

		expect(plugin.secretStorage.delete).toHaveBeenCalledWith(SECRET_KEYS.DEVICE_ID);
		expect(plugin.settings.deviceId).toBe('');
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
	});
});
