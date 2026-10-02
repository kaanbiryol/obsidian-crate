import { validateEncryptionState, encryptionScopeForPath, type EncryptionServerState } from '../../encryption/server-state';
import { ENCRYPTED_FILE_CONTENT_TYPE, isEncryptedFile, parseEncryptedFile, type EncryptedFileDescriptor } from '../../encryption/file-format';
import { FILE_PATH_MATCH, filePathArgs } from './file-identity';
import { validateEncryptedSchedules } from '../../encryption/notification-format';

export const ENCRYPTION_STATE_KEY = 'e2ee:state';
export const ENCRYPTION_FILE_PREFIX = 'e2ee:file:';

export class EncryptionStateError extends Error {
	constructor(message: string, readonly status = 409) { super(message); this.name = 'EncryptionStateError'; }
}

export async function readEncryptionState(db: D1Database): Promise<EncryptionServerState | null> {
	const row = await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(ENCRYPTION_STATE_KEY).first<{ value: string }>();
	if (!row) return null;
	const state: unknown = JSON.parse(row.value);
	validateEncryptionState(state);
	return state;
}

/** Use in the SAME transaction as publishing bytes. A request authorized before
 * conversion starts must not be able to commit a late plaintext upload. */
export function encryptionWriteGuard(state: EncryptionServerState | null): { sql: string; args: string[] } {
	if (!state) return { sql: 'NOT EXISTS (SELECT 1 FROM maintenance_state WHERE key = ?)', args: [ENCRYPTION_STATE_KEY] };
	if (state.mode !== 'active') throw new EncryptionStateError('Encryption conversion is in progress. Resume it before syncing.');
	return { sql: `EXISTS (SELECT 1 FROM maintenance_state WHERE key = ? AND json_extract(value, '$.mode') = 'active'
		AND json_extract(value, '$.vaultId') = ? AND json_extract(value, '$.generation') = CAST(? AS INTEGER))`,
		args: [ENCRYPTION_STATE_KEY, state.vaultId, String(state.generation)] };
}

export async function prepareEncryptedFileCommit(db: D1Database, path: string, content: string | ArrayBuffer, knownState?: EncryptionServerState | null): Promise<{
	state: EncryptionServerState | null;
	descriptor?: EncryptedFileDescriptor;
}> {
	const state = knownState === undefined ? await readEncryptionState(db) : knownState;
	if (!state) return { state };
	if (state.mode !== 'active') throw new EncryptionStateError('Encryption conversion is in progress. Resume it before syncing.');
	return { state, descriptor: validateEncryptedContent(state, path, content) };
}

/** Validate the entire upload before acquiring leases or storing any R2 bytes.
 * Publication still rechecks encryption and reset authority transactionally. */
export async function validateUploadEncryption(db: D1Database, files: Array<{
	path: string; content: Uint8Array | ArrayBuffer; contentType: string;
}>, knownState?: EncryptionServerState | null): Promise<EncryptionServerState | null> {
	const state = knownState === undefined ? await readEncryptionState(db) : knownState;
	if (!state) return null;
	if (state.mode !== 'active') throw new EncryptionStateError('Encryption conversion is in progress. Resume it before syncing.');
	for (const file of files) {
		if (file.contentType !== ENCRYPTED_FILE_CONTENT_TYPE) throw new EncryptionStateError('This vault requires encrypted file content', 428);
		try {
			validateEncryptedContent(state, file.path, file.content);
		} catch (error) {
			if (error instanceof EncryptionStateError) throw error;
			throw new EncryptionStateError('Invalid encrypted file content', 428);
		}
	}
	return state;
}

export function validateEncryptedContent(state: EncryptionServerState, path: string, content: string | ArrayBuffer | Uint8Array): EncryptedFileDescriptor {
	const bytes = typeof content === 'string' || content instanceof Uint8Array ? content : new Uint8Array(content);
	if (!isEncryptedFile(bytes)) throw new EncryptionStateError('This vault requires encrypted file content', 428);
	const { descriptor, publicData } = parseEncryptedFile(bytes);
	const scope = encryptionScopeForPath(state, path);
	if (descriptor.vaultId !== state.vaultId || descriptor.scopeId !== scope.id || descriptor.keyId !== scope.keyId) {
		throw new EncryptionStateError('File encryption keys do not match this vault or folder', 428);
	}
	if (scope.id !== 'vault' && state.scopes.find(item => item.id === scope.id)?.purpose !== 'reading' && path.toLowerCase().endsWith('.md')) {
		validateEncryptedSchedules(publicData);
		const notificationKey = state.scopes.find(item => item.id === scope.id)!.notificationKeyId;
		for (const reminder of publicData.reminders) {
			if (reminder.notification.vaultId !== state.vaultId || reminder.notification.scopeId !== scope.id
				|| reminder.notification.keyId !== notificationKey) throw new EncryptionStateError('Notification encryption keys do not match this folder');
		}
	} else if (publicData !== null) throw new EncryptionStateError('This file must not publish reminder scheduling metadata');
	return descriptor;
}

/** An immutable descriptor is published only if its file publication succeeds. */
export function recordEncryptedFile(db: D1Database, path: string, storageKey: string, descriptor?: EncryptedFileDescriptor): D1PreparedStatement[] {
	if (!descriptor) return [];
	return [db.prepare(`INSERT INTO maintenance_state (key, value, updated_at)
		SELECT ?, ?, datetime('now') WHERE EXISTS (SELECT 1 FROM files WHERE ${FILE_PATH_MATCH} AND storage_key = ?)
		ON CONFLICT(key) DO NOTHING`).bind(ENCRYPTION_FILE_PREFIX + storageKey, JSON.stringify(descriptor), ...filePathArgs(path), storageKey)];
}
