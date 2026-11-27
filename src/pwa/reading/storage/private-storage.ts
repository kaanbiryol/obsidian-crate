import type { LocalStateCipher } from '@/encryption/local-state';
import { readingKeyRange, readingKeys } from './storage-keys';
let cipher: LocalStateCipher | undefined;
let required = false;
let lockReason: string | undefined;
// A check without an answer on a device with no encryption evidence: plaintext reads only.
let plaintextReadable = false;
// A plaintext record was found where encryption is required, such as one an older tab wrote.
let plaintextFound = false;
let onPlaintextFound: (() => void) | undefined;
/** Whether a read refused a plaintext record that the migration must convert. */
export const plaintextReadingFound = (): boolean => plaintextFound;
export function forgetPlaintextReadingFound(): void { plaintextFound = false; }
/** Called when a read refuses plaintext, so storage can drop the encryption checks that
 * would otherwise let later unlocks, after a reload too, skip converting it. */
export function onPlaintextReadingFound(listener: () => void): void { onPlaintextFound = listener; }
/** Called in the transaction of every write; a plaintext write drops all encryption checks,
 * so the next unlock reads the store again. A thrown encode aborts the deletion with it. */
export async function forgetEncryptionChecks(store: { delete(range: IDBKeyRange): Promise<void> }): Promise<void> {
	if (!cipher) await store.delete(readingKeyRange(readingKeys.encryptionCheck('')));
}
export function lockReadingStorage(encrypted = true, reason?: string, readPlaintext = false): void { cipher?.destroy(); cipher = undefined; required = encrypted; lockReason = reason; plaintextReadable = readPlaintext; }
export function unlockReadingStorage(value: LocalStateCipher): void { cipher?.destroy(); cipher = value; required = true; lockReason = undefined; plaintextReadable = false; }
export function encodeReadingValue(key: string, value: unknown): unknown {
	if (required && !cipher) throw new Error(lockReason ?? 'Unlock Reading before saving private data.');
	return cipher ? { encryptedReading: 1, content: cipher.seal(JSON.stringify(value), key) } : value;
}
export function decodeReadingValue(key: string, value: unknown): unknown {
	if (value === undefined) return value;
	if (value && typeof value === 'object' && 'encryptedReading' in value) {
		if (value.encryptedReading !== 1) throw new Error('Saved Reading data uses an unsupported encryption format. Update Crate before opening it.');
		if (!cipher || !('content' in value) || typeof value.content !== 'string') throw new Error('Unlock Reading to open saved private data.');
		return JSON.parse(cipher.open(value.content, key)) as unknown;
	}
	if (required && !plaintextReadable) {
		plaintextFound = true;
		onPlaintextFound?.();
		throw new Error(lockReason ?? 'Private Reading storage needs migration before opening.');
	}
	return value;
}
