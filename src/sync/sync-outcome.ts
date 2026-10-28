import { Notice } from 'obsidian';
import { getSyncIssues, recordSyncError, recordSyncIssue, SkippedFileError } from './issues';
import type { Logger } from './logger';
import { errorMessage } from '../platform/logger';
import type { SyncResult, SyncState } from './types';
import { isAuthError, isAuthFailure } from './failures';
import {
	cancelSyncResult,
	createSyncFailureResult,
	finalizeSyncResult,
	getSyncResultError,
	SYNC_ERROR_MESSAGES,
} from './sync-result';
import { isAbortError } from './abort';

export const AUTH_ERROR_MESSAGE = 'This device’s sync access is no longer valid. In Crate settings → Account and devices, select “Reconnect”.';

export type SyncStatus = SyncState['status'];

/** Starts every sync entry the same way: refuses an unconfigured or busy engine,
 * otherwise publishes `syncing`. `enter` runs after the guard passes and before
 * that transition, and returns state to publish with it. Returns the refusal, or
 * null once the attempt has started. */
export function beginSyncAttempt(
	context: { apiConfigured(): boolean; getStatus(): SyncStatus; updateState(updates: Partial<SyncState>): void },
	enter?: () => Partial<SyncState>,
): SyncResult | null {
	if (!context.apiConfigured()) return createSyncFailureResult(SYNC_ERROR_MESSAGES.NOT_CONFIGURED);
	if (context.getStatus() === 'syncing') return createSyncFailureResult(SYNC_ERROR_MESSAGES.ALREADY_IN_PROGRESS);
	context.updateState({ ...enter?.(), status: 'syncing' });
	return null;
}

/** Shows the reconnect notice once per authorization failure episode, so background
 * flushes that keep failing do not repeat it. A successful sync ends the episode; new
 * credentials replace the engine and with it this gate. */
export class ReconnectNotice {
	private shown = false;

	show(): void {
		if (this.shown) return;
		this.shown = true;
		new Notice(AUTH_ERROR_MESSAGE);
	}

	reset(): void {
		this.shown = false;
	}
}

export interface WorkflowCompletionContext {
	updateState(updates: Partial<SyncState>): void;
	setLastSync(value: string): void;
	reconnectNotice: ReconnectNotice;
}

interface OutcomeOptions {
	/** Published with the outcome by queue flushes, which track the pending count. */
	pendingChanges?: number;
	/** Replaces the first recorded error, for queue flushes that list every failed file. */
	errorSummary?: string;
}

/** Publishes a finished result. Every sync path, including queue flushes and queue
 * reconciliation, uses it, so a success also records `lastSync` in settings. */
export function completeWorkflowResult(
	context: WorkflowCompletionContext,
	result: SyncResult,
	options: OutcomeOptions & {
		errorFallback: string;
	},
): void {
	const pending = pendingUpdate(options);
	if (finalizeSyncResult(result)) {
		const lastSync = new Date().toISOString();
		context.updateState({
			status: 'idle',
			lastSync,
			lastError: null,
			...pending,
		});
		context.setLastSync(lastSync);
		context.reconnectNotice.reset();
		return;
	}

	if (result.outcome === 'cancelled') {
		context.updateState({ status: 'idle', ...pending });
		return;
	}
	context.updateState({
		status: 'error',
		lastError: options.errorSummary ?? getSyncResultError(result, options.errorFallback),
		lastIssues: getSyncIssues(result),
		...pending,
	});
}

export interface WorkflowErrorContext {
	updateState(updates: Partial<SyncState>): void;
	reconnectNotice: ReconnectNotice;
}

interface AuthFailureOptions extends Pick<OutcomeOptions, 'pendingChanges'> {
	failureLogPrefix: string;
	logger: Logger;
}

/** Revoked access reads the same on every path: the reconnect message and a notice. */
function publishAuthFailure(context: WorkflowErrorContext, result: SyncResult, options: AuthFailureOptions): void {
	result.errors.push(AUTH_ERROR_MESSAGE);
	options.logger.error(`${options.failureLogPrefix}: auth error (401)`);
	context.reconnectNotice.show();
	context.updateState({ status: 'error', lastError: AUTH_ERROR_MESSAGE, ...pendingUpdate(options) });
}

/** Publishes a result whose transfers report failures per file. A revoked token rejects
 * every file, so any per-file 401 publishes the reconnect failure, as a thrown one does. */
export function completeTransferResult(
	context: WorkflowCompletionContext & WorkflowErrorContext,
	result: SyncResult,
	failures: ReadonlyArray<{ status?: number }>,
	options: OutcomeOptions & AuthFailureOptions & { errorFallback: string },
): void {
	if (failures.some(failure => isAuthFailure(failure.status))) publishAuthFailure(context, result, options);
	else completeWorkflowResult(context, result, options);
}

export function handleWorkflowError(
	context: WorkflowErrorContext,
	result: SyncResult,
	error: unknown,
	options: OutcomeOptions & AuthFailureOptions & {
		abortLogMessage: string;
		logGenericError?: boolean;
		/** Per-file failures that stopped the workflow; a 401 among them reads as revoked access. */
		failures?: ReadonlyArray<{ status?: number }>;
	},
): void {
	if (isAbortError(error)) {
		cancelSyncResult(result);
		context.updateState({ status: 'idle', ...pendingUpdate(options) });
		options.logger.info(options.abortLogMessage);
		return;
	}

	if (isAuthError(error) || options.failures?.some(failure => isAuthFailure(failure.status))) {
		publishAuthFailure(context, result, options);
		return;
	}

	const errMsg = errorMessage(error);
	// The error stopped the workflow, so it is a failure even when it names a skipped file.
	if (error instanceof SkippedFileError) recordSyncIssue(result, error.issue);
	else recordSyncError(result, error);
	if (options.logGenericError) {
		options.logger.error(`${options.failureLogPrefix}:`, errMsg);
	}
	context.updateState({
		status: 'error',
		lastError: options.errorSummary ?? getSyncResultError(result, errMsg),
		lastIssues: getSyncIssues(result),
		...pendingUpdate(options),
	});
}

function pendingUpdate(options: Pick<OutcomeOptions, 'pendingChanges'>): Partial<SyncState> {
	return options.pendingChanges === undefined ? {} : { pendingChanges: options.pendingChanges };
}
