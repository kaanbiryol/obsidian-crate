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
