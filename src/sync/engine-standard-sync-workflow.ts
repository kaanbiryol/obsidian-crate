import { computeHash } from './hasher';
import {
	createEmptySyncResult,
	finalizeSyncResult,
} from './sync-result';
import {
	PREPARE_CONCURRENCY,
	UPLOAD_CONCURRENCY,
} from './engine-constants';
import { createLogger, errorMessage } from '../plugin/logger';
import type { FileDiff, FileEntry, SyncResult, SyncState } from '../plugin/types';
import {
	completeWorkflowResult,
	getStartFailureResult,
	handleWorkflowError,
	type FullSyncPlan,
	type RemoteManifest,
	type SyncStatus,
} from './engine-workflow-shared';

const logger = createLogger('SyncEngine');

export interface SyncWorkflowContext {
	apiConfigured(): boolean;
	getStatus(): SyncStatus;
	updateState(updates: Partial<SyncState>): void;
	getManifest(): Promise<RemoteManifest>;
	incrementalSync(
		progressCallback?: (current: number, total: number) => void
	): Promise<SyncResult | null>;
	isAbortError(error: unknown): boolean;
	throwIfDestroyed(): void;
	createFullSyncPlan(
		remoteFiles: Record<string, FileEntry>,
		concurrency: number
	): Promise<FullSyncPlan>;
	processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult
	): Promise<void>;
	parallelDownloadAndSaveFiles(paths: string[], result: SyncResult): Promise<void>;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
	readBinary(path: string): Promise<ArrayBuffer>;
	getModifiedIso(path: string, fallbackMtime?: number): Promise<string>;
	setLocalManifestEntry(path: string, entry: FileEntry): void;
	saveLocalManifest(): Promise<void>;
	setLastSync(value: string): void;
	setLastSeq(value: number): void;
}

export async function runSyncWorkflow(
	context: SyncWorkflowContext,
	progressCallback?: (current: number, total: number) => void
): Promise<SyncResult> {
	const startFailure = getStartFailureResult(context);
	if (startFailure) return startFailure;

	context.updateState({ status: 'syncing' });
	logger.info('Sync started');

	try {
		const incrementalResult = await context.incrementalSync(progressCallback);
		if (incrementalResult) {
			completeWorkflowResult(context, incrementalResult, {
				errorFallback: 'Incremental sync completed with errors',
				conflictCount: incrementalResult.conflicts.length,
			});
			return incrementalResult;
		}
	} catch (error) {
		if (context.isAbortError(error)) {
			logger.info('Incremental sync aborted');
			return createEmptySyncResult();
		}
		throw error;
	}

	logger.info('Running full sync');

	const result = createEmptySyncResult();

	try {
		context.throwIfDestroyed();
		const remoteManifest = await context.getManifest();
		const plan = await context.createFullSyncPlan(remoteManifest.files, PREPARE_CONCURRENCY);

		const {
			localFiles,
			diffs,
			uploadDiffs,
			downloadDiffs,
			remainingDiffs,
			errors,
		} = plan;
		result.errors.push(...errors);

		const conflictDiffs = diffs.filter(diff => diff.action === 'conflict');
		const deleteDiffs = diffs.filter(diff => diff.action === 'delete');
		logger.info(
			`Full sync diffs: ${uploadDiffs.length} upload, ${downloadDiffs.length} download, ${conflictDiffs.length} conflict, ${deleteDiffs.length} delete`,
		);

		const total = diffs.length;
		let current = 0;

		if (uploadDiffs.length > 0) {
			const uploadTasks = uploadDiffs.map(diff => async () => {
				try {
					await context.processDiff(diff, localFiles, result);
				} catch (error) {
					result.errors.push(`${diff.path}: ${errorMessage(error)}`);
				}
				current++;
				progressCallback?.(current, total);
			});
			await context.runConcurrent(uploadTasks, UPLOAD_CONCURRENCY);
		}

		context.throwIfDestroyed();

		if (downloadDiffs.length > 0) {
			await context.parallelDownloadAndSaveFiles(
				downloadDiffs.map(diff => diff.path),
				result,
			);
			for (const diff of downloadDiffs) {
				try {
					const content = await context.readBinary(diff.path);
					const hash = await computeHash(content);
					localFiles[diff.path] = {
						hash,
						size: content.byteLength,
						modified: await context.getModifiedIso(diff.path),
					};
				} catch {
					// File may have failed to download; error already recorded.
				}
			}
			current += downloadDiffs.length;
			progressCallback?.(current, total);
		}

		context.throwIfDestroyed();

		for (const diff of remainingDiffs) {
			try {
				await context.processDiff(diff, localFiles, result);
			} catch (error) {
				result.errors.push(`${diff.path}: ${errorMessage(error)}`);
			}
			current++;
			progressCallback?.(current, total);
		}

		for (const [path, entry] of Object.entries(localFiles)) {
			context.setLocalManifestEntry(path, entry);
		}
		await context.saveLocalManifest();

		const lastSync = new Date().toISOString();
		context.updateState({
			status: 'idle',
			lastSync,
			lastError: result.errors.length > 0 ? result.errors[0] ?? null : null,
			conflictCount: result.conflicts.length,
		});
		context.setLastSync(lastSync);
		if (
			result.errors.length === 0
			&& remoteManifest.lastSeq !== undefined
			&& remoteManifest.lastSeq > 0
		) {
			context.setLastSeq(remoteManifest.lastSeq);
		}

		logger.info(
			`Full sync completed: ${result.uploaded} up, ${result.downloaded} down, ${result.conflicts.length} conflicts`,
		);
	} catch (error) {
		handleWorkflowError(context, result, error, {
			abortLogMessage: 'Full sync aborted',
			failureLogPrefix: 'Full sync failed',
			logger,
			logGenericError: true,
		});
	}

	finalizeSyncResult(result);
	return result;
}
