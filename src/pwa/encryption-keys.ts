import type { DBSchema } from 'idb';
import { importEncryptionSecret, encryptBytes, decryptBytes, type EncryptionKey } from '../encryption/envelope';
import { isEncryptionFolderPath, validateReminderKeyGrant, type ReminderKeyGrant } from '../encryption/key-bundle';
import { LocalStateCipher } from '../encryption/local-state';
import { importNotificationFingerprintKey } from '../encryption/reminder-projection';
import { isEncryptionId } from '../encryption/encoding';
import { clearSessionStore } from './clear-session-store';
import { openEncryptedDatabase } from './encrypted-storage-database';
import { verifyScopeBinding, type BoundScopeState } from '../encryption/scope-binding';

export interface StoredReminderKeys {
	version: 1;
	vaultId: string;
	scopeId: string;
	folderPath: string;
	generation: number;
	accessId?: string;
	/** A browser's durable requests keep their original namespace across renames. */
	localFolderPath?: string;
	data: EncryptionKey;
	notifications: EncryptionKey;
	notificationFingerprint: CryptoKey;
	localState: string;
}
interface EncryptionDatabase extends DBSchema {
	keys: { key: string; value: StoredReminderKeys };
}
const id = (vaultId: string, scopeId: string) => `${vaultId}:${scopeId}`;
const context = (keys: Pick<StoredReminderKeys, 'vaultId' | 'scopeId'>) => ({ ...keys, objectId: 'browser-state-key', purpose: 'local-state' as const });
function openKeyDatabase() {
	return openEncryptedDatabase<EncryptionDatabase>('crate-encryption-keys', 'keys');
}

function wrappingKey(key: EncryptionKey | undefined): key is EncryptionKey {
	return !!key && isEncryptionId(key.id) && key.key?.type === 'secret'
		&& !key.key.extractable && key.key.algorithm?.name === 'AES-KW' && 'length' in key.key.algorithm && key.key.algorithm.length === 256
		&& key.key.usages?.includes('wrapKey') && key.key.usages.includes('unwrapKey');
}

function validateStoredIdentity(value: StoredReminderKeys, vaultId: string, scopeId: string): void {
	if (!value || value.version !== 1 || value.vaultId !== vaultId || value.scopeId !== scopeId || !Number.isSafeInteger(value.generation) || value.generation < 1
		|| typeof value.folderPath !== 'string' || value.folderPath.split('/').some(part => !part || part === '.' || part === '..')
		|| value.accessId !== undefined && !isEncryptionId(value.accessId)
		|| value.localFolderPath !== undefined && !isEncryptionFolderPath(value.localFolderPath)
		|| typeof value.localState !== 'string') throw new Error('The saved folder keys are damaged. Preserve pending changes before recovering.');
}

function validateStoredKeys(value: StoredReminderKeys, vaultId: string, scopeId: string): void {
	validateStoredIdentity(value, vaultId, scopeId);
	if (!wrappingKey(value.data) || !wrappingKey(value.notifications) || value.notificationFingerprint?.algorithm?.name !== 'HMAC'
		|| value.notificationFingerprint.extractable || !value.notificationFingerprint.usages?.includes('sign')) throw new Error('The saved folder keys are damaged. Preserve pending changes before recovering.');
}

/** IndexedDB stores non-extractable CryptoKeys, never the enrollment secret. */
export async function rememberReminderKeys(grant: ReminderKeyGrant, isCurrent = () => true, localFolderPath?: string): Promise<StoredReminderKeys> {
	validateReminderKeyGrant(grant);
	if (localFolderPath !== undefined && !isEncryptionFolderPath(localFolderPath)) throw new Error('Invalid local folder.');
	const database = await openKeyDatabase();
	try {
		const previous = await database.get('keys', id(grant.vaultId, grant.scope.id));
		if (previous !== undefined) {
			// A verified grant can replace damaged CryptoKeys, but must preserve the
			// existing wrapped local secret that protects pending edits and drafts.
			validateStoredIdentity(previous, grant.vaultId, grant.scope.id);
			if (previous.folderPath !== grant.scope.folderPath && (previous.generation >= grant.generation
				|| previous.data?.id !== grant.scope.data.id || previous.notifications?.id !== grant.scope.notifications.id)) {
				throw new Error('The saved keys belong to a different folder. Use its latest setup link.');
			}
		}
		if (previous && previous.generation > grant.generation) throw new Error('This enrollment uses older encryption keys');
		const data = await importEncryptionSecret(grant.scope.data);
		const notifications = await importEncryptionSecret(grant.scope.notifications);
		const notificationFingerprint = await importNotificationFingerprintKey(grant.vaultId, grant.scope);
		const scope = { vaultId: grant.vaultId, scopeId: grant.scope.id };
		const previousKey = previous && wrappingKey(previous.data) && previous.data.id !== data.id && previous.generation < grant.generation ? previous.data : data;
		const localSecret = previous ? await decryptBytes(previous.localState, previousKey, context(scope)) : crypto.getRandomValues(new Uint8Array(32));
		try {
			if (localSecret.length !== 32) throw new Error('Damaged browser encryption key. Preserve pending changes before recovery.');
			const stored: StoredReminderKeys = { version: 1, ...scope, folderPath: grant.scope.folderPath, generation: grant.generation,
				...(grant.scope.accessId ? { accessId: grant.scope.accessId } : {}),
				localFolderPath: localFolderPath ?? previous?.localFolderPath ?? previous?.folderPath ?? grant.scope.folderPath,
				data, notifications, notificationFingerprint, localState: await encryptBytes(localSecret, data, context(scope)) };
			if (!isCurrent()) throw new Error('Session changed before enrollment');
			const tx = database.transaction('keys', 'readwrite');
			const current = await tx.store.get(id(scope.vaultId, scope.scopeId));
			if (current?.localState !== previous?.localState || !isCurrent()) { tx.abort(); await tx.done.catch(() => {}); throw new Error('Encryption enrollment changed in another tab. Retry the link.'); }
			await tx.store.put(stored, id(scope.vaultId, scope.scopeId));
			await tx.done;
			return stored;
		} finally { localSecret.fill(0); }
	} finally { database.close(); }
}

export async function readReminderKeys(vaultId: string, scopeId: string): Promise<StoredReminderKeys | undefined> {
	const database = await openKeyDatabase();
	try { const value = await database.get('keys', id(vaultId, scopeId)); if (value !== undefined) validateStoredKeys(value, vaultId, scopeId); return value; }
	finally { database.close(); }
}

/** Preserve CryptoKeys and the wrapped local secret. Only a client-authenticated
 * mapping may change routing; merely trusting a new server path would broaden access. */
export async function followEncryptionScope(previous: StoredReminderKeys, state: BoundScopeState, localFolderPath: string, isCurrent: () => boolean): Promise<StoredReminderKeys> {
	const matches = (keys: StoredReminderKeys) => keys.vaultId === state.vaultId && keys.scopeId === state.scope.id
		&& keys.data.id === state.scope.keyId && keys.notifications.id === state.scope.notificationKeyId
		&& (keys.accessId ?? keys.scopeId) === (state.scope.accessId ?? state.scope.id);
	if (!matches(previous) || previous.generation > state.generation
		|| previous.generation === state.generation && previous.folderPath !== state.scope.folderPath
		|| ![previous.folderPath, previous.localFolderPath].includes(localFolderPath)) throw new Error('This folder connection needs a fresh setup link.');
	if (previous.generation === state.generation && previous.folderPath === state.scope.folderPath) return previous;
	await verifyScopeBinding(state, previous.data);
	const db = await openKeyDatabase();
	try {
		if (!isCurrent()) throw new Error('Session changed before updating its folder.');
		const tx = db.transaction('keys', 'readwrite');
		const current = await tx.store.get(id(previous.vaultId, previous.scopeId));
		if (!current || !matches(current) || current.localState !== previous.localState || current.generation > state.generation || !isCurrent()) {
			tx.abort(); await tx.done.catch(() => {}); throw new Error('The saved folder connection changed. Retry.');
		}
		const next = { ...current, folderPath: state.scope.folderPath, localFolderPath: current.localFolderPath ?? previous.folderPath, generation: state.generation };
		await tx.store.put(next, id(next.vaultId, next.scopeId)); await tx.done;
		return next;
	} finally { db.close(); }
}

export async function unlockLocalState(keys: StoredReminderKeys): Promise<LocalStateCipher> {
	const secret = await decryptBytes(keys.localState, keys.data, context({ vaultId: keys.vaultId, scopeId: keys.scopeId }));
	try { return new LocalStateCipher(keys.vaultId, keys.scopeId, secret); }
	finally { secret.fill(0); }
}

export async function clearReminderKeys(isCurrent: () => boolean): Promise<void> {
	if (!isCurrent()) return;
	const database = await openKeyDatabase();
	try { await clearSessionStore(database, 'keys', isCurrent); }
	finally { database.close(); }
}

/** Recovery exports retain wrapped local secrets, never a CryptoKey or raw key.
 * Each record can be opened later with its original folder recovery grant. */
export async function exportWrappedLocalKeys(): Promise<unknown[]> {
	const database = await openKeyDatabase();
	try {
		return (await database.getAll('keys')).map(value => ({ version: value.version, vaultId: value.vaultId,
			scopeId: value.scopeId, folderPath: value.folderPath, generation: value.generation,
			keyId: value.data?.id, localState: value.localState }));
	} finally { database.close(); }
}
