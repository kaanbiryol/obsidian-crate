import { describe, expect, it, vi } from 'vitest';
import type { SecretStorageService } from '../plugin/secret-storage';
import { SECRET_KEYS, type CrateSettings } from '../plugin/settings-types';
import { clearSyncConfigurationState } from './runtime-config';

describe('clearSyncConfigurationState', () => {
	it('deletes the scoped credential before clearing its Worker URL scope', () => {
		const settings = { workerUrl: 'https://crate.example.workers.dev' } as CrateSettings;
		const deleteSecret = vi.fn((key: string) => {
			expect(key).toBe(SECRET_KEYS.AUTH_TOKEN);
			expect(settings.workerUrl).toBe('https://crate.example.workers.dev');
		});
		const secretStorage = { delete: deleteSecret } as unknown as SecretStorageService;

		clearSyncConfigurationState(settings, secretStorage);

		expect(deleteSecret).toHaveBeenCalledOnce();
		expect(settings.workerUrl).toBe('');
	});
});
