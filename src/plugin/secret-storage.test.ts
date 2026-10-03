import { describe, expect, it, vi } from 'vitest';
import { SECRET_KEYS } from './settings-types';
import { SecretStorageService } from './secret-storage';
import { createVaultKeyBundle, generateRecoveryCode } from '../encryption/key-bundle';
import { loadEncryptionKeys, saveEncryptionKeys } from './encryption-storage';

function createSecretStorage(scopeProvider?: () => string | null) {
	const secrets = new Map<string, string>();
	const app = {
		secretStorage: {
			getSecret: vi.fn((id: string) => secrets.get(id) ?? null),
			setSecret: vi.fn((id: string, value: string) => {
				secrets.set(id, value);
			}),
			listSecrets: vi.fn(() => [...secrets.keys()]),
		},
	};
	return {
		service: new SecretStorageService(app as never, scopeProvider),
		secrets,
	};
}

describe('SecretStorageService', () => {
	it('scopes Worker credentials to their Cloudflare deployment', () => {
		const { service, secrets } = createSecretStorage(() => 'deployment-a');

		service.set(SECRET_KEYS.AUTH_TOKEN, 'token-a');

		const [storageId] = [...secrets.keys()];
		expect(storageId).toMatch(/^crate-[a-f0-9]{16}-auth-token$/);
		expect(storageId).not.toBe(SECRET_KEYS.AUTH_TOKEN);
		expect(service.get(SECRET_KEYS.AUTH_TOKEN)).toBe('token-a');
	});

	it('does not share credentials between deployments', () => {
		let scope = 'deployment-a';
		const { service } = createSecretStorage(() => scope);
		service.set(SECRET_KEYS.AUTH_TOKEN, 'token-a');

		scope = 'deployment-b';
		expect(service.get(SECRET_KEYS.AUTH_TOKEN)).toBeNull();
		service.set(SECRET_KEYS.AUTH_TOKEN, 'token-b');

		scope = 'deployment-a';
		expect(service.get(SECRET_KEYS.AUTH_TOKEN)).toBe('token-a');
		scope = 'deployment-b';
		expect(service.get(SECRET_KEYS.AUTH_TOKEN)).toBe('token-b');
	});

	it('keeps the physical device identity shared across deployments', () => {
		const { service, secrets } = createSecretStorage(() => 'deployment-a');

		service.set(SECRET_KEYS.DEVICE_ID, 'device-id');

		expect(secrets.get(SECRET_KEYS.DEVICE_ID)).toBe('device-id');
	});

	it('isolates encryption keys and recovery codes from separately stored device credentials', async () => {
		let scope = 'https://first.example';
		const { service } = createSecretStorage(() => scope);
		const first = createVaultKeyBundle(), second = createVaultKeyBundle();
		const firstCode = await generateRecoveryCode(), secondCode = await generateRecoveryCode();
		saveEncryptionKeys(service, first, firstCode);
		service.delete(SECRET_KEYS.AUTH_TOKEN);
		expect(loadEncryptionKeys(service)).toEqual(first);
		scope = 'https://second.example';
		expect(loadEncryptionKeys(service)).toBeNull();
		expect(service.get(SECRET_KEYS.ENCRYPTION_RECOVERY)).toBeNull();
		saveEncryptionKeys(service, second, secondCode);
		scope = 'https://first.example';
		expect(loadEncryptionKeys(service)).toEqual(first);
		expect(service.get(SECRET_KEYS.ENCRYPTION_RECOVERY)).toBe(firstCode);
		scope = 'https://second.example';
		expect(loadEncryptionKeys(service)).toEqual(second);
	});

	it('fails before conversion if secret storage does not retain the key bundle', async () => {
		const bundle = createVaultKeyBundle(), code = await generateRecoveryCode();
		const broken = { set: vi.fn(), get: () => null } as unknown as SecretStorageService;
		expect(() => saveEncryptionKeys(broken, bundle, code)).toThrow('Could not verify saved encryption keys');
		const { service } = createSecretStorage();
		service.set(SECRET_KEYS.ENCRYPTION_KEYS, '{broken');
		expect(() => loadEncryptionKeys(service)).toThrow();
	});
});


it.each([SECRET_KEYS.ENCRYPTION_RESET, SECRET_KEYS.ENCRYPTION_FOLDER_MOVES])('keeps %s checkpoints isolated to the original deployment', key => {
	let scope = 'first';
	const { service } = createSecretStorage(() => scope);
	service.set(key, 'first checkpoint');
	scope = 'second';
	expect(service.get(key)).toBeNull();
	service.set(key, 'second checkpoint');
	scope = 'first';
	expect(service.get(key)).toBe('first checkpoint');
});
