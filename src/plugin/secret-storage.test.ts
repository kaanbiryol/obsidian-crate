import { describe, expect, it, vi } from 'vitest';
import { SECRET_KEYS } from './settings-types';
import { SecretStorageService } from './secret-storage';

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
});
