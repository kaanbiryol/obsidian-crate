import { isEncryptionId } from './encoding';

// Match the existing plaintext request limit, allowing for base64url, JWE
// headers and the settings/version wrapper. The stored row remains below 2 MB.
export const MAX_SHARED_SETTINGS_BYTES = 1024 * 1024;
const MAX_SETTINGS_ENVELOPE_CHARACTERS = Math.ceil(MAX_SHARED_SETTINGS_BYTES * 4 / 3) + 4096;
export const MAX_ENCRYPTED_SETTINGS_REQUEST_BYTES = MAX_SETTINGS_ENVELOPE_CHARACTERS + 4096;

export interface EncryptedSettings {
	version: 1;
	vaultId: string;
	keyId: string;
	envelope: string;
}
export function validateEncryptedSettings(value: unknown): asserts value is EncryptedSettings {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid encrypted settings');
	const item = value as Partial<EncryptedSettings>;
	if (Object.keys(item).some(key => !['version', 'vaultId', 'keyId', 'envelope'].includes(key))
		|| item.version !== 1 || !isEncryptionId(item.vaultId) || !isEncryptionId(item.keyId)
		|| typeof item.envelope !== 'string' || item.envelope.length > MAX_SETTINGS_ENVELOPE_CHARACTERS || item.envelope.split('.').length !== 5) {
		throw new Error('Unsupported encrypted settings');
	}
}
