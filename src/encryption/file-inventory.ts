import { isRecord, isSha256Hex } from '@/platform/validation';
import { sha256Hex } from '@/platform/sha256';
import { openFile, type FileEncryptionAuthority } from './file-codec';
import { isSyncPath } from '@/protocol/sync-validation';

export interface EncryptedInventoryFile { path: string; hash: string; size: number; revision: string }
export interface EncryptedInventoryPage {
	files: EncryptedInventoryFile[];
	sequence: number;
	generation: number;
	nextCursor: string | null;
}

/** Files per encrypted inventory page. Clients page the whole inventory after
 * any vault change, so pages are large. */
export const ENCRYPTED_INVENTORY_PAGE = 1000;

/** Both encrypted feature endpoints expose the same bounded wire page. */
export function parseEncryptedInventoryPage(value: unknown, folder: string, generation: number): EncryptedInventoryPage {
	if (!isRecord(value) || value.generation !== generation || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 0
		|| !Array.isArray(value.files) || value.files.length > ENCRYPTED_INVENTORY_PAGE
		|| !(value.nextCursor === null || typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= 4096)) {
		throw new Error('Invalid encrypted file inventory');
	}
	const files: EncryptedInventoryFile[] = [];
	const paths = new Set<string>();
	for (const file of value.files) {
		if (!isRecord(file) || !isSyncPath(file.path) || !file.path.startsWith(`${folder}/`)
			|| !isSha256Hex(file.hash)
			|| typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.revision !== 'string' || !file.revision) {
			throw new Error('Invalid encrypted file metadata');
		}
		if (paths.has(file.path)) throw new Error('Encrypted inventory repeated a file');
		paths.add(file.path);
		files.push({ path: file.path, hash: file.hash, size: file.size, revision: file.revision });
	}
	return { files, generation, sequence: value.sequence, nextCursor: value.nextCursor };
}

/** Count pages independently of files so empty advancing responses stay bounded.
 * Feature clients retain sequence-change retry policy and publish only complete loads. */
export function createEncryptedInventoryProgress(limits: { maxFiles: number; maxPages: number }): (page: EncryptedInventoryPage) => void {
	let pages = 0;
	let cursor: string | null = null;
	const paths = new Set<string>();
	return page => {
		if (++pages > limits.maxPages || pages === limits.maxPages && page.nextCursor !== null
			|| paths.size + page.files.length > limits.maxFiles) throw new Error('Encrypted file inventory exceeds this device’s limit');
		if (page.nextCursor !== null && cursor !== null && page.nextCursor <= cursor) throw new Error('Encrypted file pagination did not advance');
		for (const file of page.files) {
			if (paths.has(file.path)) throw new Error('Encrypted inventory repeated a file');
			paths.add(file.path);
		}
		cursor = page.nextCursor;
	};
}

/** Pages per encrypted inventory, counted separately from files. */
const MAX_ENCRYPTED_INVENTORY_PAGES = 1000;

/** Page one complete encrypted inventory at a single vault sequence. Every page
 * passes the device limits before it is yielded, and a changed sequence throws the
 * caller's `changed()` error. With `confirm`, a fresh first page fetched after the
 * caller handled the last page must still report that sequence, so files read
 * while paging belong to one snapshot. */
export async function* encryptedInventoryPages(
	fetchPage: (after?: string) => Promise<EncryptedInventoryPage>,
	options: { maxFiles: number; first?: EncryptedInventoryPage; confirm?: boolean; changed(): Error },
): AsyncGenerator<EncryptedInventoryPage, void, undefined> {
	const acceptPage = createEncryptedInventoryProgress({ maxFiles: options.maxFiles, maxPages: MAX_ENCRYPTED_INVENTORY_PAGES });
	let page = options.first ?? await fetchPage();
	const { sequence } = page;
	while (true) {
		if (page.sequence !== sequence) throw options.changed();
		acceptPage(page);
		yield page;
		if (!page.nextCursor) break;
		page = await fetchPage(page.nextCursor);
	}
	if (options.confirm && (await fetchPage()).sequence !== sequence) throw options.changed();
}

/** Coarse ciphertext bound checked before download; features enforce their plaintext limit after opening.
 * The Worker applies the same bound to encrypted web app downloads and commits. */
export const MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES = 4 * 1024 * 1024;

/** Open transferred ciphertext only when it matches its inventory entry byte for byte. */
export async function openVerifiedInventoryFile(bytes: Uint8Array<ArrayBuffer>, file: EncryptedInventoryFile, authority: FileEncryptionAuthority, integrityError: string) {
	if (bytes.byteLength !== file.size || await sha256Hex(bytes) !== file.hash) throw new Error(integrityError);
	return openFile(bytes, file.path, authority);
}
