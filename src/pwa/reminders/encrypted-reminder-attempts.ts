import type { DBSchema } from 'idb';
import { reminderOperationDay, REMINDER_RETRY_DAYS } from '../../protocol/reminder-operation';
import { sealPrivateValue, openPrivateValue, REMINDER_OUTBOX_PREFIX, REMINDER_DRAFT_PREFIX } from './private-storage';
import { clearSessionStore } from '../storage/clear-session-store';
import { abortTransaction } from '../storage/abort-transaction';
import { openEncryptedDatabase } from '../storage/encrypted-storage-database';
import { isRecord, isSha256Hex } from '../../platform/validation';

export interface EncryptedReminderAttempt { semanticHash: string; body: string; generation: number; rejected?: boolean; acknowledgment?: string }
interface AttemptDatabase extends DBSchema { attempts: { key: string; value: string } }
const openAttempts = () => openEncryptedDatabase<AttemptDatabase>('crate-encrypted-reminder-attempts', 'attempts');

function decodeAttempt(raw: string, key: string): EncryptedReminderAttempt {
	const attempt = JSON.parse(openPrivateValue(raw, `attempt:${key}`)) as EncryptedReminderAttempt;
	if (!attempt || !isSha256Hex(attempt.semanticHash) || typeof attempt.body !== 'string'
		|| !Number.isSafeInteger(attempt.generation) || attempt.generation < 1
		|| (attempt.rejected !== undefined && typeof attempt.rejected !== 'boolean') || (attempt.acknowledgment !== undefined && typeof attempt.acknowledgment !== 'string')) throw new Error('The saved encrypted attempt is damaged. Preserve pending changes before recovering.');
	return attempt;
}

export async function loadEncryptedReminderAttempt(key: string): Promise<EncryptedReminderAttempt | undefined> {
	const db = await openAttempts();
	try { const raw = await db.get('attempts', key); return raw === undefined ? undefined : decodeAttempt(raw, key); }
	finally { db.close(); }
}

export async function saveEncryptedReminderAttempt(key: string, attempt: EncryptedReminderAttempt, previous: EncryptedReminderAttempt | undefined, isCurrent: () => boolean): Promise<void> {
	const encoded = sealPrivateValue(JSON.stringify(attempt), `attempt:${key}`);
	const db = await openAttempts();
	try {
		if (!isCurrent()) throw new Error('Session changed before saving');
		const tx = db.transaction('attempts', 'readwrite');
		const raw = await tx.store.get(key);
		const current = raw === undefined ? undefined : decodeAttempt(raw, key);
		if (JSON.stringify(current) !== JSON.stringify(previous) || !isCurrent()) { await abortTransaction(tx); throw new Error('This encrypted save changed in another tab. Retry its saved attempt.'); }
		await tx.store.put(encoded, key); await tx.done;
	} finally { db.close(); }
}

/** Caller holds the outbox Web Lock. Only acknowledged attempts can expire,
 * using the SERVER's retry day, never this device's clock. Unknown/damaged and
 * uncertain entries are preserved. Work is bounded and scoped to unlocked keys. */
export async function pruneEncryptedReminderAttempts(scope: { vaultId: string; folderPath: string },
	serverDay: number, isCurrent: () => boolean, after?: string): Promise<string | undefined> {
	if (!Number.isSafeInteger(serverDay) || serverDay < 1 || serverDay > 99_999_999 || !isCurrent()) return after;
	const prefix = `${scope.vaultId}:vault:`;
	const db = await openAttempts();
	try {
		if (!isCurrent()) return after;
		// Include old sessions and malformed queue entries without decrypting them.
		const pending = new Set(Object.keys(localStorage).filter(key => key.startsWith(REMINDER_OUTBOX_PREFIX)).map(key => key.slice(key.lastIndexOf(':') + 1)));
		// Drafts are independent durable data. Skip deletion while any draft in
		// this tab might still reference an attempt, including unrecognized formats.
		const hasDraft = Object.keys(sessionStorage).some(key => key.startsWith(REMINDER_DRAFT_PREFIX));
		const tx = db.transaction('attempts', 'readwrite');
		let cursor = await tx.store.openCursor(IDBKeyRange.bound(after?.startsWith(prefix) ? after : prefix, prefix + '\uffff', true, true));
		let last: string | undefined, visited = 0;
		while (cursor && visited++ < 100) {
			if (!isCurrent()) { await abortTransaction(tx); return after; }
			last = cursor.key;
			const operationId = cursor.key.slice(prefix.length), day = reminderOperationDay(operationId);
			let attempt: EncryptedReminderAttempt | undefined;
			try { attempt = decodeAttempt(cursor.value, cursor.key); } catch { /* Keep damaged bytes for recovery. */ }
			if (attempt?.acknowledgment && !attempt.rejected
				&& Object.keys(attempt).every(key => ['semanticHash', 'body', 'generation', 'rejected', 'acknowledgment'].includes(key))) {
				if (day !== null && day < serverDay - (REMINDER_RETRY_DAYS - 1) && !pending.has(operationId) && !hasDraft) await cursor.delete();
			}
			cursor = await cursor.continue();
		}
		if (!isCurrent()) { await abortTransaction(tx); return after; }
		await tx.done;
		return cursor ? last : undefined;
	} finally { db.close(); }
}

/** One parsed note from the last complete encrypted list, by its server file. */
export interface IndexedReminderNote { file: { path: string; hash: string; size: number; revision: string }; path: string; reminders: unknown[]; issue?: string }
/** The most notes an encrypted reminder list may hold; its persisted index shares the bound. */
export const MAX_ENCRYPTED_REMINDER_FILES = 100_000;
// The header holds the identity; each parsed note is its own record after it, by revision.
const indexKey = (scope: string) => `note-index:${scope}`;
const noteRange = (scope: string) => IDBKeyRange.bound(`${indexKey(scope)}\u0000`, `${indexKey(scope)}\u0000￿`);
const noteKey = (scope: string, revision: string) => `${indexKey(scope)}\u0000${revision}`;

function isIndexedNote(value: unknown): value is IndexedReminderNote {
	if (!isRecord(value) || !isRecord(value.file) || typeof value.path !== 'string' || !Array.isArray(value.reminders)
		|| (value.issue !== undefined && typeof value.issue !== 'string')) return false;
	const { path, hash, size, revision } = value.file;
	return typeof path === 'string' && typeof hash === 'string' && typeof revision === 'string'
		&& Number.isSafeInteger(size) && (size as number) >= 0 && value.reminders.every(isRecord);
}

function headerIdentity(raw: string | undefined, scope: string): unknown {
	if (raw === undefined) return undefined;
	try { const value: unknown = JSON.parse(openPrivateValue(raw, indexKey(scope))); return isRecord(value) ? value.identity : undefined; }
	catch { return undefined; }
}

/** Parsed notes from the last complete encrypted list, sealed like other private data
 * and kept in this store so logout clears them. A cold start then downloads only
 * notes whose revision changed. `identity` binds them to the keys, folder and build. */
export async function loadEncryptedReminderIndex(scope: string, identity: string): Promise<IndexedReminderNote[] | undefined> {
	const db = await openAttempts();
	try {
		const tx = db.transaction('attempts', 'readonly');
		if (headerIdentity(await tx.store.get(indexKey(scope)), scope) !== identity) return undefined;
		const keys = await tx.store.getAllKeys(noteRange(scope), MAX_ENCRYPTED_REMINDER_FILES + 1);
		if (keys.length > MAX_ENCRYPTED_REMINDER_FILES) return undefined;
		const values = await tx.store.getAll(noteRange(scope), MAX_ENCRYPTED_REMINDER_FILES);
		const notes = values.map((raw, index): unknown => JSON.parse(openPrivateValue(raw, keys[index]!)));
		return notes.every((note, index) => isIndexedNote(note) && noteKey(scope, note.file.revision) === keys[index]) ? notes as IndexedReminderNote[] : undefined;
	} finally { db.close(); }
}

/** Seals and writes only notes the store lacks and removes notes no longer listed, so a
 * change costs the changed notes rather than the whole folder. A different identity
 * replaces every note. */
export async function saveEncryptedReminderIndex(scope: string, identity: string, notes: IndexedReminderNote[], isCurrent: () => boolean): Promise<void> {
	const db = await openAttempts();
	try {
		if (!isCurrent()) return;
		const tx = db.transaction('attempts', 'readwrite');
		const writes: Promise<unknown>[] = [];
		const sameIdentity = headerIdentity(await tx.store.get(indexKey(scope)), scope) === identity;
		const stored = new Set(sameIdentity ? await tx.store.getAllKeys(noteRange(scope)) : []);
		if (!sameIdentity) {
			writes.push(tx.store.delete(noteRange(scope)), tx.store.put(sealPrivateValue(JSON.stringify({ identity }), indexKey(scope)), indexKey(scope)));
		}
		const listed = new Map(notes.map(note => [noteKey(scope, note.file.revision), note]));
		for (const key of stored) if (!listed.has(key)) writes.push(tx.store.delete(key));
		// A revision's parsed note never changes, so a stored one is current.
		for (const [key, note] of listed) if (!stored.has(key)) writes.push(tx.store.put(sealPrivateValue(JSON.stringify(note), key), key));
		await Promise.all([...writes, tx.done]);
	} finally { db.close(); }
}

export async function clearEncryptedReminderAttempts(isCurrent: () => boolean): Promise<void> {
	if (!isCurrent()) return;
	const db = await openAttempts();
	try { await clearSessionStore(db, 'attempts', isCurrent); } finally { db.close(); }
}
