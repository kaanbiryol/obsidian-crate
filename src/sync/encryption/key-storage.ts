import { validateVaultKeyBundle, type VaultKeyBundle } from '../../encryption/key-bundle';
import type { SecretStorageService } from '../../plugin/secret-storage';
import { SECRET_KEYS } from '../../platform/secret-keys';

export function loadEncryptionKeys(storage: SecretStorageService): VaultKeyBundle | null {
	const raw = storage.get(SECRET_KEYS.ENCRYPTION_KEYS);
	if (!raw) return null;
	const bundle: unknown = JSON.parse(raw);
	validateVaultKeyBundle(bundle);
	return bundle;
}

export function saveEncryptionKeys(storage: SecretStorageService, bundle: VaultKeyBundle, recovery: string): void {
	validateVaultKeyBundle(bundle);
	storage.set(SECRET_KEYS.ENCRYPTION_RECOVERY, recovery);
	storage.set(SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(bundle));
	if (storage.get(SECRET_KEYS.ENCRYPTION_RECOVERY) !== recovery || JSON.stringify(loadEncryptionKeys(storage)) !== JSON.stringify(bundle)) throw new Error('Could not verify saved encryption keys. Encryption has not been started.');
}
