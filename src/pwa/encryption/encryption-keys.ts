import type { DBSchema } from 'idb';
import { importEncryptionSecret, encryptBytes, decryptBytes, type EncryptionKey } from '../../encryption/envelope';
import { validateVaultKeyBundle, type VaultKeyBundle } from '../../encryption/key-bundle';
import { LocalStateCipher } from '../../encryption/local-state';
import { importNotificationFingerprintKey } from '../../encryption/reminder-projection';
import { importSealPrivateKey } from '../../encryption/seal-key';
import { validateP256PublicKey } from '../../encryption/p256';
import { isEncryptionId } from '../../encryption/encoding';
import { clearSessionStore } from '../storage/clear-session-store';
import { abortTransaction } from '../storage/abort-transaction';
import { openEncryptedDatabase } from '../storage/encrypted-storage-database';

export interface StoredVaultKeys {
	version: 1;
	vaultId: string;
	generation: number;
	vault: EncryptionKey;
	notifications: EncryptionKey;
	notificationFingerprint: CryptoKey;
	seal: { keyId: string; publicKey: string; privateKey: CryptoKey };
	/** A random secret for private browser data, wrapped by the vault key. */
	localState: string;
}
/** Vault keys plus the folder one feature reads, for that feature's requests. */
export type FeatureKeys = StoredVaultKeys & { folderPath: string };
export type EncryptedFeature = 'reminders' | 'reading';

interface EncryptionDatabase extends DBSchema {
	keys: { key: string; value: StoredVaultKeys };
}
const context = (vaultId: string) => ({ vaultId, scopeId: 'vault', objectId: 'browser-state-key', purpose: 'local-state' as const });
function openKeyDatabase() {
	return openEncryptedDatabase<EncryptionDatabase>('crate-encryption-keys', 'keys');
}

function wrappingKey(key: EncryptionKey | undefined): key is EncryptionKey {
	return !!key && isEncryptionId(key.id) && key.key?.type === 'secret'
		&& !key.key.extractable && key.key.algorithm?.name === 'AES-KW' && 'length' in key.key.algorithm && key.key.algorithm.length === 256
		&& key.key.usages?.includes('wrapKey') && key.key.usages.includes('unwrapKey');
}

const damaged = () => new Error('The saved encryption keys are damaged. Preserve pending changes before recovering.');

function validateStoredIdentity(value: StoredVaultKeys, vaultId: string): void {
	if (!value || value.version !== 1 || value.vaultId !== vaultId || !Number.isSafeInteger(value.generation) || value.generation < 1
		|| typeof value.localState !== 'string') throw damaged();
}

function validateStoredKeys(value: StoredVaultKeys, vaultId: string): void {
	validateStoredIdentity(value, vaultId);
	const seal = value.seal;
	if (!wrappingKey(value.vault) || !wrappingKey(value.notifications) || value.notificationFingerprint?.algorithm?.name !== 'HMAC'
		|| value.notificationFingerprint.extractable || !value.notificationFingerprint.usages?.includes('sign')
		|| !seal || !isEncryptionId(seal.keyId) || seal.privateKey?.type !== 'private' || seal.privateKey.extractable
		|| seal.privateKey.algorithm?.name !== 'ECDH') throw damaged();
	validateP256PublicKey(seal.publicKey);
}

/** IndexedDB stores non-extractable CryptoKeys, never the bundle's secrets. */
export async function rememberVaultKeys(bundle: VaultKeyBundle, isCurrent = () => true): Promise<StoredVaultKeys> {
	validateVaultKeyBundle(bundle);
	const database = await openKeyDatabase();
	try {
		const previous = await database.get('keys', bundle.vaultId);
		if (previous !== undefined) {
			// Fresh CryptoKeys may replace damaged ones, but the wrapped local
			// secret that protects pending edits and drafts must be preserved.
			validateStoredIdentity(previous, bundle.vaultId);
			if (previous.generation > bundle.generation) throw new Error('This enrollment uses older encryption keys');
			// A damaged CryptoKey is repairable: the bundle's own key must still open the wrapped secret below.
			if (wrappingKey(previous.vault) && previous.vault.id !== bundle.vault.id) throw new Error('The saved keys belong to a different encrypted vault. Log out first.');
		}
		const vault = await importEncryptionSecret(bundle.vault);
		const notifications = await importEncryptionSecret(bundle.notifications);
		const notificationFingerprint = await importNotificationFingerprintKey(bundle.vaultId, bundle.notifications);
		const seal = { keyId: bundle.seal.id, publicKey: bundle.seal.publicKey, privateKey: await importSealPrivateKey(bundle.seal) };
		const localSecret = previous ? await decryptBytes(previous.localState, vault, context(bundle.vaultId)) : crypto.getRandomValues(new Uint8Array(32));
		try {
			if (localSecret.length !== 32) throw new Error('Damaged browser encryption key. Preserve pending changes before recovery.');
			const stored: StoredVaultKeys = { version: 1, vaultId: bundle.vaultId, generation: bundle.generation,
				vault, notifications, notificationFingerprint, seal, localState: await encryptBytes(localSecret, vault, context(bundle.vaultId)) };
			if (!isCurrent()) throw new Error('Session changed before enrollment');
			const tx = database.transaction('keys', 'readwrite');
			const current = await tx.store.get(bundle.vaultId);
			if (current?.localState !== previous?.localState || !isCurrent()) {
				await abortTransaction(tx);
				// Reminders and Reading may unlock at the same moment; both use the first record.
				if (current && isCurrent() && current.vault?.id === bundle.vault.id) { validateStoredKeys(current, bundle.vaultId); return current; }
				throw new Error('Encryption enrollment changed in another tab. Retry the link.');
			}
			await tx.store.put(stored, bundle.vaultId);
			await tx.done;
			return stored;
		} finally { localSecret.fill(0); }
	} finally { database.close(); }
}

export async function readVaultKeys(vaultId: string): Promise<StoredVaultKeys | undefined> {
	const database = await openKeyDatabase();
	try { const value = await database.get('keys', vaultId); if (value !== undefined) validateStoredKeys(value, vaultId); return value; }
	finally { database.close(); }
}

/** Features share one local secret; the cipher context keeps their data apart. */
export async function unlockLocalState(keys: StoredVaultKeys, feature: EncryptedFeature): Promise<LocalStateCipher> {
	const secret = await decryptBytes(keys.localState, keys.vault, context(keys.vaultId));
	try { return new LocalStateCipher(keys.vaultId, feature, secret); }
	finally { secret.fill(0); }
}

export async function clearVaultKeys(isCurrent: () => boolean): Promise<void> {
	if (!isCurrent()) return;
	const database = await openKeyDatabase();
	try { await clearSessionStore(database, 'keys', isCurrent); }
	finally { database.close(); }
}

/** Recovery exports retain wrapped local secrets, never a CryptoKey or raw key.
 * Each record can be opened later with the vault's recovery key. */
export async function exportWrappedLocalKeys(): Promise<unknown[]> {
	const database = await openKeyDatabase();
	try {
		return (await database.getAll('keys')).map(value => ({ version: value.version, vaultId: value.vaultId,
			generation: value.generation, keyId: value.vault?.id, localState: value.localState }));
	} finally { database.close(); }
}
