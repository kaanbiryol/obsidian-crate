import { Notice, type Vault } from 'obsidian';
import { computeHash } from './hasher';
import { notifyConflicts } from './conflict';
import { getAllVaultFiles, type VaultFile } from './file-discovery';
import {
	createEmptySyncResult,
	createSyncFailureResult,
	finalizeSyncResult,
	getSyncResultError,
	SYNC_ERROR_MESSAGES,
} from './sync-result';
import {
	AUTH_ERROR_MESSAGE,
	BATCH_UPLOAD_CONCURRENCY,
	FORCE_SYNC_CONCURRENCY,
	INITIAL_SYNC_PIPELINE_CHUNK_FILES,
	MAX_CHECK_BACKOFF_MULTIPLIER,
	PREPARE_CONCURRENCY,
	UPLOAD_CONCURRENCY,
	isAuthError,
} from './engine-constants';
import { createLogger, errorMessage } from '../plugin/logger';
import type {
	FileDiff,
	FileEntry,
	PreparedUpload,
	SyncResult,
	SyncState,
} from '../plugin/types';

const logger = createLogger('SyncEngine');

type SyncStatus = SyncState['status'];

interface RemoteManifest {
	files: Record<string, FileEntry>;
	lastSeq?: number;
}

interface FullSyncPlan {
	localFiles: Record<string, FileEntry>;
	diffs: FileDiff[];
	uploadDiffs: FileDiff[];
	downloadDiffs: FileDiff[];
	remainingDiffs: FileDiff[];
	errors: string[];
}

function getStartFailureResult(context: {
	apiConfigured(): boolean;
	getStatus(): SyncStatus;
}): SyncResult | null {
	if (!context.apiConfigured()) {
		return createSyncFailureResult(SYNC_ERROR_MESSAGES.NOT_CONFIGURED);
	}
	if (context.getStatus() === 'syncing') {
		return createSyncFailureResult(SYNC_ERROR_MESSAGES.ALREADY_IN_PROGRESS);
	}
	return null;
}

export interface PeriodicCheckWorkflowContext {
	apiConfigured(): boolean;
	getStatus(): SyncStatus;
	getSyncIntervalSeconds(): number;
	getLastSeq(): number;
	getPendingPathCount(): number;
	getConsecutiveCheckFailures(): number;
	setConsecutiveCheckFailures(value: number): void;
	getLastCheckAttempt(): number;
	setLastCheckAttempt(value: number): void;
	checkForChanges(lastSeq: number): Promise<{ hasChanges: boolean }>;
	sync(): Promise<SyncResult>;
}

export async function runPeriodicCheckWorkflow(
	context: PeriodicCheckWorkflowContext
): Promise<void> {
	if (context.getStatus() === 'syncing') return;
	if (!context.apiConfigured()) return;

	if (context.getConsecutiveCheckFailures() > 0) {
		const multiplier = Math.min(
			2 ** (context.getConsecutiveCheckFailures() - 1),
			MAX_CHECK_BACKOFF_MULTIPLIER,
		);
		const backoffMs = context.getSyncIntervalSeconds() * 1000 * multiplier;
		if (Date.now() - context.getLastCheckAttempt() < backoffMs) {
			return;
		}
	}
	context.setLastCheckAttempt(Date.now());

	try {
		const { hasChanges } = await context.checkForChanges(context.getLastSeq());

		if (!hasChanges && context.getPendingPathCount() === 0) {
			logger.debug('Periodic check: no changes');
			context.setConsecutiveCheckFailures(0);
			return;
		}

		logger.info('Periodic check: changes detected, running sync');
		const result = await context.sync();
		notifyConflicts(result.conflicts);
		context.setConsecutiveCheckFailures(0);
	} catch (error) {
		const failures = context.getConsecutiveCheckFailures() + 1;
		const multiplier = Math.min(2 ** (failures - 1), MAX_CHECK_BACKOFF_MULTIPLIER);
		context.setConsecutiveCheckFailures(failures);
		logger.warn(
			`Periodic check failed (attempt ${failures}, next in ~${multiplier}x interval):`,
			errorMessage(error),
		);
	}
}

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
			if (incrementalResult.success) {
				const lastSync = new Date().toISOString();
				context.updateState({
					status: 'idle',
					lastSync,
					lastError: null,
					conflictCount: incrementalResult.conflicts.length,
				});
				context.setLastSync(lastSync);
			} else {
				const lastError = getSyncResultError(
					incrementalResult,
					'Incremental sync completed with errors',
				);
				context.updateState({
					status: 'error',
					lastError,
					conflictCount: incrementalResult.conflicts.length,
				});
			}
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
		if (context.isAbortError(error)) {
			logger.info('Full sync aborted');
		} else if (isAuthError(error)) {
			result.errors.push(AUTH_ERROR_MESSAGE);
			logger.error('Full sync failed: auth error (401)');
			new Notice(AUTH_ERROR_MESSAGE);
			context.updateState({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
		} else {
			const errMsg = errorMessage(error);
			result.errors.push(errMsg);
			logger.error('Full sync failed:', errMsg);
			context.updateState({ status: 'error', lastError: errMsg });
		}
	}

	finalizeSyncResult(result);
	return result;
}

export interface InitialSyncWorkflowContext {
	vault: Vault;
	apiConfigured(): boolean;
	getStatus(): SyncStatus;
	updateState(updates: Partial<SyncState>): void;
	shouldIgnore(path: string): boolean;
	isAbortError(error: unknown): boolean;
	prepareUploadsFromVaultFiles(
		files: VaultFile[],
		onPrepared?: (completed: number) => void
	): Promise<PreparedUpload[]>;
	uploadPreparedFiles(
		prepared: PreparedUpload[],
		result: SyncResult,
		options: { concurrency: number; retry: boolean; batchConcurrency?: number }
	): Promise<void>;
	createVaultFileChunks(files: VaultFile[], chunkSize: number): VaultFile[][];
	saveLocalManifest(): Promise<void>;
	throwIfDestroyed(): void;
	setLastSync(value: string): void;
}

export async function runInitialSyncWorkflow(
	context: InitialSyncWorkflowContext,
	progressCallback?: (current: number, total: number) => void
): Promise<SyncResult> {
	const startFailure = getStartFailureResult(context);
	if (startFailure) return startFailure;

	context.updateState({ status: 'syncing' });
	const result = createEmptySyncResult();

	try {
		const files = await getAllVaultFiles(context.vault, path => context.shouldIgnore(path));
		logger.info(`Initial sync started with ${files.length} files`);
		const total = files.length;
		let preparedCount = 0;
		let uploadCandidates = 0;

		const chunks = context.createVaultFileChunks(files, INITIAL_SYNC_PIPELINE_CHUNK_FILES);
		const prepareChunk = (chunk: VaultFile[]) => context.prepareUploadsFromVaultFiles(chunk, () => {
			preparedCount++;
			progressCallback?.(preparedCount, total);
		});

		let chunkIndex = 0;
		const firstChunk = chunks[0];
		let currentPrepare = firstChunk ? prepareChunk(firstChunk) : null;
		while (currentPrepare) {
			const preparedChunk = await currentPrepare;
			context.throwIfDestroyed();
			uploadCandidates += preparedChunk.length;

			chunkIndex++;
			const nextChunk = chunks[chunkIndex];
			const nextPrepare = nextChunk ? prepareChunk(nextChunk) : null;

			if (preparedChunk.length > 0) {
				await context.uploadPreparedFiles(preparedChunk, result, {
					concurrency: UPLOAD_CONCURRENCY,
					retry: true,
					batchConcurrency: BATCH_UPLOAD_CONCURRENCY,
				});
			}

			currentPrepare = nextPrepare;
		}

		logger.info(
			`Prepared ${uploadCandidates}/${total} files for upload (${total - uploadCandidates} unchanged)`,
		);
		await context.saveLocalManifest();

		logger.info(`Initial sync completed: ${result.uploaded} uploaded`);
		if (finalizeSyncResult(result)) {
			const lastSync = new Date().toISOString();
			context.updateState({
				status: 'idle',
				lastSync,
				lastError: null,
			});
			context.setLastSync(lastSync);
		} else {
			context.updateState({
				status: 'error',
				lastError: getSyncResultError(result, 'Initial sync completed with errors'),
			});
		}
	} catch (error) {
		if (context.isAbortError(error)) {
			logger.info('Initial sync aborted');
		} else if (isAuthError(error)) {
			result.errors.push(AUTH_ERROR_MESSAGE);
			logger.error('Initial sync failed: auth error (401)');
			new Notice(AUTH_ERROR_MESSAGE);
			context.updateState({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
		} else {
			const errMsg = errorMessage(error);
			result.errors.push(errMsg);
			context.updateState({ status: 'error', lastError: errMsg });
		}
	}

	finalizeSyncResult(result);
	return result;
}

export interface ForceSyncWorkflowContext {
	vault: Vault;
	apiConfigured(): boolean;
	getStatus(): SyncStatus;
	updateState(updates: Partial<SyncState>): void;
	shouldIgnore(path: string): boolean;
	isAbortError(error: unknown): boolean;
	getManifest(): Promise<RemoteManifest>;
	clearLocalManifest(): void;
	prepareUploadsFromVaultFiles(
		files: VaultFile[],
		onPrepared?: (completed: number) => void
	): Promise<PreparedUpload[]>;
	uploadPreparedFiles(
		prepared: PreparedUpload[],
		result: SyncResult,
		options: { concurrency: number; retry: boolean; batchConcurrency?: number }
	): Promise<void>;
	throwIfDestroyed(): void;
	deleteRemoteFile(path: string): Promise<void>;
	removeLocalManifestEntry(path: string): void;
	saveLocalManifest(): Promise<void>;
	setLastSync(value: string): void;
}

export async function runForceFullSyncWorkflow(
	context: ForceSyncWorkflowContext,
	progressCallback?: (current: number, total: number) => void
): Promise<SyncResult> {
	const startFailure = getStartFailureResult(context);
	if (startFailure) return startFailure;

	context.updateState({ status: 'syncing' });
	const result = createEmptySyncResult();

	try {
		const remoteManifest = await context.getManifest();
		const remotePaths = new Set(Object.keys(remoteManifest.files));

		const files = await getAllVaultFiles(context.vault, path => context.shouldIgnore(path));
		const localPaths = new Set(files.map(file => file.path));

		const remoteOnlyPaths = [...remotePaths].filter(
			path => !localPaths.has(path) && !context.shouldIgnore(path),
		);

		const total = files.length + remoteOnlyPaths.length;
		let current = 0;

		context.clearLocalManifest();

		const prepared = await context.prepareUploadsFromVaultFiles(files, completed => {
			current = completed;
			progressCallback?.(current, total);
		});

		context.throwIfDestroyed();

		await context.uploadPreparedFiles(prepared, result, {
			concurrency: FORCE_SYNC_CONCURRENCY,
			retry: true,
		});

		context.throwIfDestroyed();

		for (const path of remoteOnlyPaths) {
			try {
				await context.deleteRemoteFile(path);
				context.removeLocalManifestEntry(path);
				result.deleted++;
				result.deletedPaths.push(path);
			} catch (error) {
				result.errors.push(`delete ${path}: ${errorMessage(error)}`);
			}
			current++;
			progressCallback?.(current, total);
		}

		await context.saveLocalManifest();

		const lastSync = new Date().toISOString();
		logger.info(
			`Force full sync completed: ${result.uploaded} uploaded, ${result.deleted} remote-only deleted`,
		);
		if (finalizeSyncResult(result)) {
			context.updateState({
				status: 'idle',
				lastSync,
				lastError: null,
			});
			context.setLastSync(lastSync);
		} else {
			context.updateState({
				status: 'error',
				lastError: getSyncResultError(result, 'Force full sync completed with errors'),
			});
		}
	} catch (error) {
		if (context.isAbortError(error)) {
			logger.info('Force full sync aborted');
		} else if (isAuthError(error)) {
			result.errors.push(AUTH_ERROR_MESSAGE);
			logger.error('Force full sync failed: auth error (401)');
			new Notice(AUTH_ERROR_MESSAGE);
			context.updateState({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
		} else {
			const errMsg = errorMessage(error);
			result.errors.push(errMsg);
			logger.error('Force full sync failed:', errMsg);
			context.updateState({ status: 'error', lastError: errMsg });
		}
	}

	finalizeSyncResult(result);
	return result;
}
