import { isEncryptionId } from './encoding';
import { isRecoveryEnvelope, type RecoveryEnvelope, type VaultKeyBundle } from './key-bundle';
import { validateP256PublicKey } from './p256';

export const ENCRYPTION_CAPABILITY = 'e2ee-v1';
/** Authenticated responses say whether the vault is encrypted ('on' or 'off'),
 * so clients can skip probing /encryption before plaintext requests. */
export const ENCRYPTION_STATE_HEADER = 'X-Crate-Encryption-State';
/** Requests to an encrypted vault name the vault and key generation they use. */
export const ENCRYPTION_VAULT_HEADER = 'X-Crate-Encryption-Vault';
export const ENCRYPTION_GENERATION_HEADER = 'X-Crate-Encryption-Generation';

/** The server's record of an encryption reset, answered to the device that started it. */
export interface ResetReceipt { id: string; vaultId: string; generation: number; complete: boolean }

/** Public routing metadata and a recovery envelope. No unwrapped secrets. */
export interface EncryptionServerState {
	version: 1;
	vaultId: string;
	generation: number;
	mode: 'converting' | 'active' | 'resetting';
	keyId: string;
	notificationKeyId: string;
	/** Public half of the vault seal key: the server can create notes it cannot read. */
	seal: { keyId: string; publicKey: string };
	recovery: RecoveryEnvelope;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function exactFields(value: Record<string, unknown>, fields: string[]): void {
	if (Object.keys(value).some(field => !fields.includes(field))) throw new Error('Unexpected encryption configuration field');
}

export function validateEncryptionState(value: unknown): asserts value is EncryptionServerState {
	if (!record(value)) throw new Error('Invalid encryption configuration');
	exactFields(value, ['version', 'vaultId', 'generation', 'mode', 'keyId', 'notificationKeyId', 'seal', 'recovery']);
	if (value.version !== 1 || !isEncryptionId(value.vaultId) || !isEncryptionId(value.keyId) || !isEncryptionId(value.notificationKeyId)
		|| !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
		|| (value.mode !== 'converting' && value.mode !== 'active' && value.mode !== 'resetting')) throw new Error('Unsupported encryption configuration');
	if (!record(value.seal)) throw new Error('Missing vault seal key');
	exactFields(value.seal, ['keyId', 'publicKey']);
	if (!isEncryptionId(value.seal.keyId)) throw new Error('Invalid vault seal key');
	validateP256PublicKey(value.seal.publicKey);
	if (new Set([value.keyId, value.notificationKeyId, value.seal.keyId, 'vault']).size !== 4) throw new Error('Duplicate encryption key');
	if (!record(value.recovery)) throw new Error('Missing encrypted recovery bundle');
	exactFields(value.recovery, ['version', 'vaultId', 'envelope']);
	if (!isRecoveryEnvelope(value.recovery, value.vaultId)) throw new Error('Invalid encrypted recovery bundle');
}

export function createEncryptionState(bundle: VaultKeyBundle, recovery: RecoveryEnvelope): EncryptionServerState {
	const state: EncryptionServerState = { version: 1, vaultId: bundle.vaultId, generation: bundle.generation,
		mode: 'converting', keyId: bundle.vault.id, notificationKeyId: bundle.notifications.id,
		seal: { keyId: bundle.seal.id, publicKey: bundle.seal.publicKey }, recovery };
	validateEncryptionState(state);
	return state;
}

/** Keys unlock this server only when every key identity matches its public state. */
export function assertEncryptionKeys(state: EncryptionServerState, bundle: VaultKeyBundle): void {
	if (state.vaultId !== bundle.vaultId || state.generation !== bundle.generation || state.keyId !== bundle.vault.id
		|| state.notificationKeyId !== bundle.notifications.id || state.seal.keyId !== bundle.seal.id || state.seal.publicKey !== bundle.seal.publicKey) {
		throw new Error('Recover this server’s encryption keys before continuing');
	}
}
