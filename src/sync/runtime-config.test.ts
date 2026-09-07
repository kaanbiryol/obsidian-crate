import { describe, expect, it, vi } from 'vitest';
import type { SecretStorageService } from '../plugin/secret-storage';
import { SECRET_KEYS, type CrateSettings } from '../plugin/settings-types';
import { clearSyncConfigurationState, deleteManifestFile } from './runtime-config';

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

it('does not remove a manifest after unloading during its existence check', async () => {
	const lifetime = new AbortController();
	const remove = vi.fn();
	const plugin = {
		manifest: { dir: '.obsidian/plugins/crate' },
		app: { vault: { adapter: {
			exists: async () => { lifetime.abort(); return true; },
			remove,
		} } },
	};
	await expect(deleteManifestFile(plugin as never, lifetime.signal)).rejects.toMatchObject({ name: 'AbortError' });
	expect(remove).not.toHaveBeenCalled();
});
