import type { PreparedUpload } from '../types';
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import { Platform } from 'obsidian';
import type { VaultFile } from '../local/file-discovery';
import { PREPARE_CONCURRENCY } from './constants';

const MIB = 1024 * 1024;

const MOBILE_TRANSFER_BUDGET_BYTES = 48 * MIB;
const DESKTOP_TRANSFER_BUDGET_BYTES = 128 * MIB;
const MAX_TRANSFER_CHUNK_FILES = 128;

export function getTransferBudgetBytes(): number {
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

/** Retain only one upload chunk, reserving room for the next maximum-size file.
 * Up to `concurrency` items prepare at once; each in-flight preparation reserves a
 * maximum-size file, and chunks keep item order. A failure waits for preparations
 * already started before it propagates. */
export async function* prepareUploadChunks<T>(
	items: T[],
	prepare: (item: T) => Promise<PreparedUpload | null>,
	maxBytes = getTransferBudgetBytes(),
	maxFiles = MAX_TRANSFER_CHUNK_FILES,
	availableBytes = () => maxBytes,
	concurrency = PREPARE_CONCURRENCY,
): AsyncGenerator<PreparedUpload[]> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < MAX_FILE_SIZE_BYTES
		|| !Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error('Invalid upload preparation budget');
	let chunk: PreparedUpload[] = [];
	let bytes = 0;
	let next = 0;
	const preparing: Array<Promise<PreparedUpload | null>> = [];
	// An empty chunk always takes its first item, as a chunk never yields empty.
	const canStart = () => next < items.length && preparing.length < concurrency && (chunk.length + preparing.length === 0
		|| (chunk.length + preparing.length < maxFiles && bytes + (preparing.length + 1) * MAX_FILE_SIZE_BYTES <= availableBytes()));
	try {
		while (next < items.length || preparing.length) {
			while (canStart()) {
				const started = prepare(items[next++]!);
				// Observe failures at once; each is raised in item order.
				void started.catch(() => {});
				preparing.push(started);
			}
			if (!preparing.length) {
				yield chunk;
				chunk = [];
				bytes = 0;
				continue;
			}
			const upload = await preparing.shift()!;
			if (!upload) continue;
			if (upload.content.byteLength > MAX_FILE_SIZE_BYTES) throw new Error('Prepared upload exceeds file size limit');
			chunk.push(upload);
			bytes += upload.content.byteLength;
		}
		if (chunk.length) yield chunk;
	} finally {
		await Promise.allSettled(preparing);
	}
}

/** Prepare one chunk ahead only when both chunks fit the existing byte budget. */
export async function* pipelineUploadChunks<T>(
	items: T[],
	prepare: (item: T) => Promise<PreparedUpload | null>,
	maxBytes = getTransferBudgetBytes(),
	maxFiles = MAX_TRANSFER_CHUNK_FILES / 2,
): AsyncGenerator<PreparedUpload[]> {
	let available = maxBytes;
	const source = prepareUploadChunks(items, prepare, maxBytes, maxFiles, () => available);
	let pending: Promise<IteratorResult<PreparedUpload[]>> | undefined;
	try {
		let next = await source.next();
		while (!next.done) {
			const chunk = next.value;
			available = maxBytes - chunk.reduce((sum, file) => sum + file.content.byteLength, 0);
			if (available >= MAX_FILE_SIZE_BYTES) {
				pending = source.next();
				// Observe failures immediately, then propagate them after the active upload.
				void pending.catch(() => {});
			}
			yield chunk;
			available = maxBytes;
			next = pending ? await pending : await source.next();
			pending = undefined;
		}
	} finally {
		await pending?.catch(() => {});
		await source.return(undefined);
	}
}
