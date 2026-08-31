import { Notice } from 'obsidian';
import { errorMessage, type Logger } from '../plugin/logger';
import type { DownloadDiff, FileDiff, SyncResult, SyncState, UploadDiff } from './types';
import type { FileEntry } from '../protocol/sync-types';
import { AUTH_ERROR_MESSAGE, isAuthError } from './engine-constants';
import {
	createSyncFailureResult,
	finalizeSyncResult,
	getSyncResultError,
	SYNC_ERROR_MESSAGES,
} from './sync-result';

export type SyncStatus = SyncState['status'];

export interface RemoteManifest {
	files: Record<string, FileEntry>;
	lastSeq?: number;
}

export interface FullSyncPlan {
	localFiles: Record<string, FileEntry>;
	diffs: FileDiff[];
	uploadDiffs: UploadDiff[];
	downloadDiffs: DownloadDiff[];
	remainingDiffs: FileDiff[];
	errors: string[];
}

export function getStartFailureResult(context: {
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

export interface WorkflowCompletionContext {
	updateState(updates: Partial<SyncState>): void;
	setLastSync(value: string): void;
}

export function completeWorkflowResult(
	context: WorkflowCompletionContext,
	result: SyncResult,
	options: {
		errorFallback: string;
	},
): void {
	const hadExplicitFailure = !result.success;

	if (finalizeSyncResult(result) && !hadExplicitFailure) {
		const lastSync = new Date().toISOString();
		context.updateState({
			status: 'idle',
			lastSync,
			lastError: null,
		});
		context.setLastSync(lastSync);
		return;
	}

	result.success = false;
	context.updateState({
		status: 'error',
		lastError: getSyncResultError(result, options.errorFallback),
	});
}

export interface WorkflowErrorContext {
	isAbortError(error: unknown): boolean;
	updateState(updates: Partial<SyncState>): void;
}

export function handleWorkflowError(
	context: WorkflowErrorContext,
	result: SyncResult,
	error: unknown,
	options: {
		abortLogMessage: string;
		failureLogPrefix: string;
		logger: Logger;
		logGenericError?: boolean;
	},
): void {
	if (context.isAbortError(error)) {
		options.logger.info(options.abortLogMessage);
		return;
	}

	if (isAuthError(error)) {
		result.errors.push(AUTH_ERROR_MESSAGE);
		options.logger.error(`${options.failureLogPrefix}: auth error (401)`);
		new Notice(AUTH_ERROR_MESSAGE);
		context.updateState({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
		return;
	}

	const errMsg = errorMessage(error);
	result.errors.push(errMsg);
	if (options.logGenericError) {
		options.logger.error(`${options.failureLogPrefix}:`, errMsg);
	}
	context.updateState({ status: 'error', lastError: errMsg });
}
