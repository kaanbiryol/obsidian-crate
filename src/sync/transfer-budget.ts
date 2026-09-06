import type { PreparedUpload } from './types';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { Platform } from 'obsidian';
import type { VaultFile } from './file-discovery';

const MIB = 1024 * 1024;

const MOBILE_TRANSFER_BUDGET_BYTES = 48 * MIB;
const DESKTOP_TRANSFER_BUDGET_BYTES = 128 * MIB;
const MAX_TRANSFER_CHUNK_FILES = 128;

function getTransferBudgetBytes(): number {
	return Platform.isMobile ? MOBILE_TRANSFER_BUDGET_BYTES : DESKTOP_TRANSFER_BUDGET_BYTES;
}

/**
 * Groups vault files by declared size so preparing a group cannot retain an
 * unbounded number of file buffers. A single large file occupies its own group.
 */
export function createByteBudgetedVaultFileChunks(
	files: VaultFile[],
	maxBytes = getTransferBudgetBytes(),
	maxFiles = MAX_TRANSFER_CHUNK_FILES,
): VaultFile[][] {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new Error('Transfer byte budget must be a positive integer');
	}
	if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
		throw new Error('Transfer file budget must be a positive integer');
	}

	const chunks: VaultFile[][] = [];
	let chunk: VaultFile[] = [];
	let chunkBytes = 0;

	for (const file of files) {
		const fileBytes = Math.max(0, file.size);
		if (
			chunk.length > 0
			&& (chunk.length >= maxFiles || chunkBytes + fileBytes > maxBytes)
		) {
			chunks.push(chunk);
			chunk = [];
			chunkBytes = 0;
		}

		chunk.push(file);
		chunkBytes += fileBytes;
	}

	if (chunk.length > 0) chunks.push(chunk);
	return chunks;
}

/** Retain only one upload chunk, reserving room for the next maximum-size file. */
export async function* prepareUploadChunks<T>(
	items: T[],
	prepare: (item: T) => Promise<PreparedUpload | null>,
	maxBytes = getTransferBudgetBytes(),
	maxFiles = MAX_TRANSFER_CHUNK_FILES,
): AsyncGenerator<PreparedUpload[]> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < MAX_FILE_SIZE_BYTES
		|| !Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error('Invalid upload preparation budget');
	let chunk: PreparedUpload[] = [];
	let bytes = 0;
	for (const item of items) {
		if (chunk.length && (bytes + MAX_FILE_SIZE_BYTES > maxBytes || chunk.length >= maxFiles)) {
			yield chunk;
			chunk = [];
			bytes = 0;
		}
		const upload = await prepare(item);
		if (!upload) continue;
		if (upload.content.byteLength > MAX_FILE_SIZE_BYTES) throw new Error('Prepared upload exceeds file size limit');
		chunk.push(upload);
		bytes += upload.content.byteLength;
	}
	if (chunk.length) yield chunk;
}
