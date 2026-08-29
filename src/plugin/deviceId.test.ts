import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensurePluginDeviceId, setPluginDeviceId } from './deviceId';
import { SECRET_KEYS } from './types';

function createPlugin(options?: {
	secrets?: Record<string, string | null>;
}): {
	settings: { deviceId: string };
	secretStorage: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
	};
} {
	const secrets = new Map<string, string>();
	for (const [key, value] of Object.entries(options?.secrets ?? {})) {
		if (value) {
			secrets.set(key, value);
		}
	}

	return {
		settings: {
			deviceId: '',
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
		},
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe('ensurePluginDeviceId', () => {
	it('hydrates the runtime deviceId from local secret storage', () => {
		const plugin = createPlugin({
			secrets: {
				[SECRET_KEYS.DEVICE_ID]: 'device-local',
			},
		});

		ensurePluginDeviceId(plugin as never);

		expect(plugin.settings.deviceId).toBe('device-local');
	});

	it('generates and securely stores a fresh local deviceId when none exists', () => {
		vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
			array.set([0, 1, 2, 3, 4, 5, 6, 7]);
			return array;
		}) as typeof crypto.getRandomValues);
		const plugin = createPlugin();

		ensurePluginDeviceId(plugin as never);

		expect(plugin.settings.deviceId).toBe('device-abcdefgh');
		expect(plugin.secretStorage.set).toHaveBeenCalledWith(SECRET_KEYS.DEVICE_ID, 'device-abcdefgh');
	});
});

describe('setPluginDeviceId', () => {
	it('writes the edited deviceId into local secret storage', () => {
		const plugin = createPlugin();

		setPluginDeviceId(plugin as never, '  device-manual  ');

		expect(plugin.secretStorage.set).toHaveBeenCalledWith(SECRET_KEYS.DEVICE_ID, 'device-manual');
		expect(plugin.settings.deviceId).toBe('device-manual');
	});

	it('removes the local secret when the deviceId field is cleared', () => {
		const plugin = createPlugin({
			secrets: {
				[SECRET_KEYS.DEVICE_ID]: 'device-existing',
			},
		});

		setPluginDeviceId(plugin as never, '   ');

		expect(plugin.secretStorage.delete).toHaveBeenCalledWith(SECRET_KEYS.DEVICE_ID);
		expect(plugin.settings.deviceId).toBe('');
	});
});
