import { isRecord, isSha256Hex } from '@/platform/validation';

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
		if (!isRecord(file) || typeof file.path !== 'string' || !file.path.startsWith(`${folder}/`) || file.path.includes('\\')
			|| file.path.split('/').some(part => !part || part === '.' || part === '..')
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
