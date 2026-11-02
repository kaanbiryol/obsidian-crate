import type { PreparedUpload, SyncResult, SyncWork } from '../types';
import { getBatchUploadConcurrency, pipelineUploadChunks } from './budget';
import { BATCH_UPLOAD_MAX_FILES } from '../../protocol/sync-limits';
import type { UploadPreparedFilesOptions } from './upload';

interface UploadPipelineContext {
	uploadPreparedFiles(prepared: PreparedUpload[], result: SyncResult, options: UploadPreparedFilesOptions): Promise<void>;
}

export interface UploadPipelineOptions<T> extends Pick<UploadPreparedFilesOptions, 'retry' | 'onFailure' | 'onVersionConflicts'> {
	/** Reads one item's upload. Null leaves it out; the callback reports why. */
	prepare(item: T): Promise<PreparedUpload | null>;
	/** Runs before each prepared chunk uploads. */
	beforeChunk?(chunk: PreparedUpload[]): void;
	/** Receives the uploading phase after `beforeChunk` and as files are processed, counted against every item. */
	reportWork?(work: SyncWork): void;
	/** Receives counts of processed files as the transfer reports them. */
	onProcessed?(count: number): void;
	/** Runs after each chunk uploads with the number of its files the transfer did
	 * not report, such as those left when cancellation stopped it early. */
	afterChunk?(unreported: number): void;
}

/** Prepares the next byte-budgeted chunk while the current one uploads through the
 * shared executor. Each sync mode supplies its preparation, retry, failure and
 * progress policy. */
export async function uploadPipelined<T>(
	context: UploadPipelineContext,
	items: T[],
	result: SyncResult,
	options: UploadPipelineOptions<T>,
): Promise<void> {
	let processed = 0;
	const report = () => options.reportWork?.({ phase: 'uploading', current: processed, total: items.length });
	// One chunk fills every batch request slot; the byte budget still bounds memory.
	for await (const chunk of pipelineUploadChunks(items, item => options.prepare(item), undefined, getBatchUploadConcurrency() * BATCH_UPLOAD_MAX_FILES)) {
		options.beforeChunk?.(chunk);
		report();
		let reported = 0;
		await context.uploadPreparedFiles(chunk, result, {
			retry: options.retry,
			...(options.onFailure ? { onFailure: options.onFailure } : {}),
			...(options.onVersionConflicts ? { onVersionConflicts: options.onVersionConflicts } : {}),
			onProcessed: count => {
				reported += count;
				processed += count;
				report();
				options.onProcessed?.(count);
			},
		});
		options.afterChunk?.(chunk.length - reported);
	}
}
