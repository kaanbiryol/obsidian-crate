import { isRecord, isSha256Hex } from '@/platform/validation';
import { sha256Hex } from '@/platform/sha256';
import { openFile, type FileEncryptionAuthority, type PathBinding } from './file-codec';
import { isSyncPath } from '@/protocol/sync-validation';

/** `modified` is the server's time of the file's last write. */
export interface EncryptedInventoryFile { path: string; hash: string; size: number; revision: string; modified: string }
/** Whether two listings name the same immutable file, so a copy opened from one serves the other. */
export function sameInventoryFile(a: EncryptedInventoryFile, b: EncryptedInventoryFile): boolean {
	return a.path === b.path && a.revision === b.revision && a.hash === b.hash && a.size === b.size;
}
/** Every inventory response is one server snapshot. `changeToken` names it: the Worker
 * answers 304 to `If-None-Match` with it while nothing changed, and pages with the same
 * token belong together. `deltaBase` asks for only the notes changed since. */
interface EncryptedInventorySnapshot { generation: number; changeToken: string; deltaBase: string }
export interface EncryptedInventoryPage extends EncryptedInventorySnapshot {
	files: EncryptedInventoryFile[];
	nextCursor: string | null;
}
/** The folder's notes changed since a delta base: `files` holds their current entries,
 * `removed` the paths no longer listed. */
export interface EncryptedInventoryDelta extends EncryptedInventorySnapshot {
	delta: true;
	files: EncryptedInventoryFile[];
	removed: string[];
}

/** Files per encrypted inventory page, and the most changes a delta lists. A full
 * listing is only needed without a usable delta base, so pages are large. */
export const ENCRYPTED_INVENTORY_PAGE = 1000;

const isChangeToken = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const isDeltaBase = (value: unknown): value is string => typeof value === 'string' && /^\d{1,15}\.[a-f0-9]{32}$/.test(value);

/** Both encrypted feature endpoints expose the same bounded wire page or delta. */
export function parseEncryptedInventoryResponse(value: unknown, folder: string, generation: number): EncryptedInventoryPage | EncryptedInventoryDelta {
	const delta = isRecord(value) && value.delta === true;
	if (!isRecord(value) || value.generation !== generation || !isChangeToken(value.changeToken) || !isDeltaBase(value.deltaBase)
		|| !Array.isArray(value.files) || value.files.length > ENCRYPTED_INVENTORY_PAGE
		|| (delta ? !Array.isArray(value.removed) || value.removed.length > ENCRYPTED_INVENTORY_PAGE || value.nextCursor !== undefined
			: !(value.nextCursor === null || typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= 4096))) {
		throw new Error('Invalid encrypted file inventory');
	}
	const files: EncryptedInventoryFile[] = [];
	const paths = new Set<string>();
	const inFolder = (path: unknown): path is string => isSyncPath(path) && path.startsWith(`${folder}/`);
	for (const file of value.files) {
		if (!isRecord(file) || !inFolder(file.path)
			|| !isSha256Hex(file.hash)
			|| typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.revision !== 'string' || !file.revision
			|| typeof file.modified !== 'string' || file.modified.length > 40) {
			throw new Error('Invalid encrypted file metadata');
		}
		if (paths.has(file.path)) throw new Error('Encrypted inventory repeated a file');
		paths.add(file.path);
		files.push({ path: file.path, hash: file.hash, size: file.size, revision: file.revision, modified: file.modified });
	}
	const snapshot = { files, generation, changeToken: value.changeToken, deltaBase: value.deltaBase };
	if (!delta) return { ...snapshot, nextCursor: value.nextCursor as string | null };
	const removed: string[] = [];
	for (const path of value.removed as unknown[]) {
		if (!inFolder(path)) throw new Error('Invalid encrypted file metadata');
		if (paths.has(path)) throw new Error('Encrypted inventory repeated a file');
		paths.add(path);
		removed.push(path);
	}
	return { ...snapshot, delta: true, removed };
}

/** A full inventory page; a delta here is not an answer to the request. */
export function parseEncryptedInventoryPage(value: unknown, folder: string, generation: number): EncryptedInventoryPage {
	const page = parseEncryptedInventoryResponse(value, folder, generation);
	if ('delta' in page) throw new Error('Invalid encrypted file inventory');
	return page;
}

/** Count pages independently of files so empty advancing responses stay bounded.
 * Feature clients retain snapshot-change retry policy and publish only complete loads. */
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

/** Page one complete encrypted inventory at a single snapshot. Every page passes the
 * device limits before it is yielded, and a page from another snapshot throws the
 * caller's `changed()` error. The Worker reads each page's rows between two equal reads
 * of its change token, so pages that share the first page's token are one snapshot. */
export async function* encryptedInventoryPages(
	fetchPage: (after?: string) => Promise<EncryptedInventoryPage>,
	options: { maxFiles: number; first?: EncryptedInventoryPage; changed(): Error },
): AsyncGenerator<EncryptedInventoryPage, void, undefined> {
	const acceptPage = createEncryptedInventoryProgress({ maxFiles: options.maxFiles, maxPages: MAX_ENCRYPTED_INVENTORY_PAGES });
	let page = options.first ?? await fetchPage();
	const { changeToken } = page;
	while (true) {
		if (page.changeToken !== changeToken) throw options.changed();
		acceptPage(page);
		yield page;
		if (!page.nextCursor) break;
		page = await fetchPage(page.nextCursor);
	}
}

/** Coarse ciphertext bound checked before download; features enforce their plaintext limit after opening.
 * The Worker applies the same bound to encrypted web app downloads and commits. */
export const MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES = 4 * 1024 * 1024;

/** Open transferred ciphertext only when it matches its inventory entry byte for byte.
 * `binding` checks the plaintext path the file claims against its server path. */
export async function openVerifiedInventoryFile(bytes: Uint8Array<ArrayBuffer>, file: EncryptedInventoryFile, authority: FileEncryptionAuthority, integrityError: string, binding: PathBinding) {
	if (bytes.byteLength !== file.size || await sha256Hex(bytes) !== file.hash) throw new Error(integrityError);
	return openFile(bytes, binding, authority);
}
