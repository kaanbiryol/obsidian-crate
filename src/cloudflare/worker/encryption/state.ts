import { ENCRYPTION_GENERATION_HEADER, ENCRYPTION_VAULT_HEADER, validateEncryptionState, type EncryptionServerState } from '../../../encryption/server-state';
import { ENCRYPTED_FILE_CONTENT_TYPE, isEncryptedFile, parseEncryptedFile, type EncryptedFileDescriptor } from '../../../encryption/file-format';
import { fileRevisionGuard } from '../sync/file-identity';
import { validateEncryptedSchedules } from '../../../encryption/notification-format';
import { isWirePath } from '../../../protocol/encrypted-path';

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

/** Whether the request was made with this vault's current encryption keys. */
export function hasEncryptionAuthority(request: Request, state: EncryptionServerState): boolean {
	return request.headers.get(ENCRYPTION_VAULT_HEADER) === state.vaultId
		&& request.headers.get(ENCRYPTION_GENERATION_HEADER) === String(state.generation);
}

/** Use in the SAME transaction as publishing bytes. A request authorized before
 * encryption is turned on must not be able to commit a late plaintext upload. */
export function encryptionWriteGuard(state: EncryptionServerState | null): { sql: string; args: string[] } {
	if (!state) return { sql: 'NOT EXISTS (SELECT 1 FROM maintenance_state WHERE key = ?)', args: [ENCRYPTION_STATE_KEY] };
	if (state.mode !== 'active') throw new EncryptionStateError('An encryption reset is in progress. Resume it on the device that started it.');
	return { sql: `EXISTS (SELECT 1 FROM maintenance_state WHERE key = ? AND json_extract(value, '$.mode') = 'active'
		AND json_extract(value, '$.vaultId') = ? AND json_extract(value, '$.generation') = CAST(? AS INTEGER))`,
		args: [ENCRYPTION_STATE_KEY, state.vaultId, String(state.generation)] };
}

export async function prepareEncryptedFileCommit(db: D1Database, path: string, content: string | ArrayBuffer, knownState?: EncryptionServerState | null, sealed?: SealedCommit): Promise<{
	state: EncryptionServerState | null;
	descriptor?: EncryptedFileDescriptor;
}> {
	const state = knownState === undefined ? await readEncryptionState(db) : knownState;
	if (!state) return { state };
	if (state.mode !== 'active') throw new EncryptionStateError('An encryption reset is in progress. Resume it on the device that started it.');
	return { state, descriptor: validateEncryptedContent(state, path, content, sealed) };
}

/** Validate the entire upload before acquiring leases or storing any R2 bytes.
 * Publication still rechecks encryption and reset authority transactionally. */
export async function validateUploadEncryption(db: D1Database, files: Array<{
	path: string; content: Uint8Array | ArrayBuffer; contentType: string;
}>, knownState?: EncryptionServerState | null): Promise<EncryptionServerState | null> {
	const state = knownState === undefined ? await readEncryptionState(db) : knownState;
	if (!state) return null;
	if (state.mode !== 'active') throw new EncryptionStateError('An encryption reset is in progress. Resume it on the device that started it.');
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

/** The server's own sealed Reading capture, which may use the seal key in this folder. */
export interface SealedCommit { readingFolder: string }

export function validateEncryptedContent(state: EncryptionServerState, path: string, content: string | ArrayBuffer | Uint8Array, sealed?: SealedCommit): EncryptedFileDescriptor {
	// Encrypted vaults store tagged names only; a readable path is never published.
	if (!isWirePath(path)) throw new EncryptionStateError('Update Crate: this encrypted vault stores encrypted file names', 428);
	const bytes = typeof content === 'string' || content instanceof Uint8Array ? content : new Uint8Array(content);
	if (!isEncryptedFile(bytes)) throw new EncryptionStateError('This vault requires encrypted file content', 428);
	const { descriptor, publicData } = parseEncryptedFile(bytes);
	if (descriptor.seal || sealed) {
		if (!descriptor.seal || !sealed || descriptor.vaultId !== state.vaultId || descriptor.scopeId !== 'vault' || descriptor.keyId !== state.seal.keyId
			|| !path.startsWith(`${sealed.readingFolder}/`) || path.slice(sealed.readingFolder.length + 1).includes('/')
			|| !path.endsWith('.md') || publicData !== null) {
			throw new EncryptionStateError('Only the server can create sealed Reading notes', 428);
		}
		return descriptor;
	}
	if (descriptor.vaultId !== state.vaultId || descriptor.scopeId !== 'vault' || descriptor.keyId !== state.keyId) {
		throw new EncryptionStateError('File encryption keys do not match this vault', 428);
	}
	// Devices decide which notes are reminders. The server only checks that any
	// published schedules use this vault's notification key.
	if (publicData === null) return descriptor;
	if (!path.toLowerCase().endsWith('.md')) throw new EncryptionStateError('This file must not publish reminder scheduling metadata');
	validateEncryptedSchedules(publicData);
	for (const reminder of publicData.reminders) {
		if (reminder.notification.vaultId !== state.vaultId || reminder.notification.scopeId !== 'vault'
			|| reminder.notification.keyId !== state.notificationKeyId) throw new EncryptionStateError('Notification encryption keys do not match this vault');
	}
	return descriptor;
}

/** An immutable descriptor is published only if its file publication succeeds. */
export function recordEncryptedFile(db: D1Database, path: string, storageKey: string, descriptor?: EncryptedFileDescriptor): D1PreparedStatement[] {
	if (!descriptor) return [];
	const revision = fileRevisionGuard(path, storageKey);
	return [db.prepare(`INSERT INTO maintenance_state (key, value, updated_at)
		SELECT ?, ?, datetime('now') WHERE ${revision.sql}
		ON CONFLICT(key) DO NOTHING`).bind(ENCRYPTION_FILE_PREFIX + storageKey, JSON.stringify(descriptor), ...revision.args)];
}
