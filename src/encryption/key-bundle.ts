import { decodeBase64Url, encodeBase64Url, isEncryptionId } from './encoding';
import { decryptJson, encryptJson, generateEncryptionSecret, importEncryptionSecret, type EncryptionSecret } from './envelope';
import { generateSealKeyPair, validateSealKeyPair, type SealKeyPair } from './seal-key';

export interface VaultKeyBundle {
	version: 1;
	vaultId: string;
	generation: number;
	/** Encrypts every file, setting and receipt in the vault. */
	vault: EncryptionSecret;
	/** Encrypts push notification text so the service worker can show it. */
	notifications: EncryptionSecret;
	seal: SealKeyPair;
}

export interface RecoveryEnvelope {
	version: 1;
	vaultId: string;
	envelope: string;
}

export async function createVaultKeyBundle(): Promise<VaultKeyBundle> {
	return { version: 1, vaultId: crypto.randomUUID(), generation: 1, vault: generateEncryptionSecret(), notifications: generateEncryptionSecret(), seal: await generateSealKeyPair() };
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSecret(value: unknown): asserts value is EncryptionSecret {
	if (!record(value) || !isEncryptionId(value.id) || typeof value.secret !== 'string'
		|| Object.keys(value).some(key => !['id', 'secret'].includes(key))
		|| decodeBase64Url(value.secret, 32).length !== 32) throw new Error('Invalid encryption key bundle');
}

export function validateVaultKeyBundle(value: unknown): asserts value is VaultKeyBundle {
	if (!record(value) || value.version !== 1 || !isEncryptionId(value.vaultId)
		|| typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 1) {
		throw new Error('Unsupported or damaged encryption key bundle');
	}
	if (Object.keys(value).some(key => !['version', 'vaultId', 'generation', 'vault', 'notifications', 'seal'].includes(key))) throw new Error('Unexpected encryption key bundle field');
	validateSecret(value.vault);
	validateSecret(value.notifications);
	validateSealKeyPair(value.seal);
	if (new Set([value.vault.id, value.notifications.id, value.seal.id]).size !== 3 || value.vault.secret === value.notifications.secret) throw new Error('Duplicate encryption key');
}

/** Compare validated bundles by identity and secret, independently of JSON order. */
export function sameVaultKeyBundle(left: VaultKeyBundle, right: VaultKeyBundle): boolean {
	const sameKey = (a: EncryptionSecret, b: EncryptionSecret) => a.id === b.id && a.secret === b.secret;
	return left.vaultId === right.vaultId && left.generation === right.generation && sameKey(left.vault, right.vault)
		&& sameKey(left.notifications, right.notifications)
		&& left.seal.id === right.seal.id && left.seal.publicKey === right.seal.publicKey && left.seal.privateKey === right.seal.privateKey;
}

const RECOVERY_PREFIX = 'crate-recovery-v1.';
async function recoveryChecksum(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 6));
}

/** A random 256-bit recovery key, not a password or a server authentication token. */
export async function generateRecoveryCode(): Promise<string> {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	try { return `${RECOVERY_PREFIX}${encodeBase64Url(bytes)}.${await recoveryChecksum(bytes)}`; }
	finally { bytes.fill(0); }
}

async function recoveryKey(code: string) {
	const parts = code.trim().split('.');
	if (parts.length !== 3 || `${parts[0]}.` !== RECOVERY_PREFIX) throw new Error('Invalid recovery key');
	const bytes = decodeBase64Url(parts[1]!, 32);
	try {
		if (bytes.length !== 32 || parts[2] !== await recoveryChecksum(bytes)) throw new Error('Invalid recovery key');
		return await importEncryptionSecret({ id: 'recovery', secret: encodeBase64Url(bytes) });
	} finally { bytes.fill(0); }
}

const recoveryContext = (vaultId: string) => ({ vaultId, scopeId: 'recovery', objectId: 'key-bundle', purpose: 'key-bundle' as const });

export async function sealRecoveryBundle(bundle: VaultKeyBundle, code: string): Promise<RecoveryEnvelope> {
	validateVaultKeyBundle(bundle);
	return { version: 1, vaultId: bundle.vaultId,
		envelope: await encryptJson(bundle, await recoveryKey(code), recoveryContext(bundle.vaultId)) };
}

/** Shape checks only; the recovery key authenticates the envelope contents. */
export function isRecoveryEnvelope(value: unknown, vaultId?: string): value is RecoveryEnvelope {
	return record(value) && value.version === 1 && isEncryptionId(value.vaultId) && (vaultId === undefined || value.vaultId === vaultId)
		&& typeof value.envelope === 'string' && value.envelope.length <= 256 * 1024 && value.envelope.split('.').length === 5;
}

export async function openRecoveryBundle(value: unknown, code: string): Promise<VaultKeyBundle> {
	if (!isRecoveryEnvelope(value)) throw new Error('Unsupported or damaged recovery bundle');
	const bundle = await decryptJson(value.envelope, await recoveryKey(code), recoveryContext(value.vaultId));
	validateVaultKeyBundle(bundle);
	if (bundle.vaultId !== value.vaultId) throw new Error('Recovery bundle belongs to another vault');
	return bundle;
}
