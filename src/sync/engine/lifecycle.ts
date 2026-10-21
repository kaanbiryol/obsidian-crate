import type { SyncResult, SyncState } from '../types';
import { createAbortError, isAbortError } from '../abort';
import { LOCAL_CONTENT_CHECK_INTERVAL_MS, MAX_RETRIES, RETRY_BASE_DELAY_MS } from './constants';
import { runPeriodicCheckWorkflow } from './periodic-workflow';
import { retryWithBackoff, runConcurrentTasks } from '../concurrency';
import { createLogger, errorMessage } from '../logger';

const logger = createLogger('SyncEngine');

interface SyncEngineLifecycleDependencies {
	automaticSyncEnabled?(): boolean;
	apiConfigured(): boolean;
	getStatus(): SyncState['status'];
	getSyncIntervalSeconds(): number;
	getLastSeq(): number;
	getPendingPathCount(): number;
	hasLocalFileChanges(): Promise<boolean>;
	/** Advance the rotating content check without network access. */
	verifyLocalContent?(): Promise<void>;
	checkForChanges(lastSeq: number): Promise<{ hasChanges: boolean; cursorExpired?: boolean }>;
	sync(): Promise<SyncResult>;
	onCheckSuccess(): void;
	onCheckFailure(error: unknown): void;
}

export class SyncEngineLifecycle {
	private syncInterval: ReturnType<typeof setInterval> | null = null;
	private abortController = new AbortController();
	private destroyed = false;
	private consecutiveCheckFailures = 0;
	private lastCheckAttempt = 0;
	private checking = false;

	constructor(private dependencies: SyncEngineLifecycleDependencies) {}

	get abortSignal(): AbortSignal {
		return this.abortController.signal;
	}

	get isDestroyed(): boolean {
		return this.destroyed;
	}

	get checkFailureCount(): number {
		return this.consecutiveCheckFailures;
	}

	startPeriodicSync(): void {
		this.stopPeriodicSync();
		if (this.destroyed) return;
		const syncIntervalSeconds = this.dependencies.getSyncIntervalSeconds();
		if (syncIntervalSeconds > 0) {
			this.syncInterval = setInterval(
				() => { void this.periodicCheck(); },
				syncIntervalSeconds * 1000,
			);
			return;
		}
		if (this.dependencies.automaticSyncEnabled?.() === false && this.dependencies.verifyLocalContent) {
			this.syncInterval = setInterval(() => { void this.localContentCheck(); }, LOCAL_CONTENT_CHECK_INTERVAL_MS);
		}
	}

	private async localContentCheck(): Promise<void> {
		if (this.destroyed || this.checking) return;
		this.checking = true;
		try { await this.dependencies.verifyLocalContent?.(); }
		catch (error) { if (!isAbortError(error)) logger.warn('Local content check failed:', errorMessage(error)); }
		finally { this.checking = false; }
	}

	settingsChanged(): void {
		this.consecutiveCheckFailures = 0;
		this.lastCheckAttempt = 0;
		this.startPeriodicSync();
	}

	async runConcurrent<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
		return runConcurrentTasks(tasks, concurrency, () => this.destroyed);
	}

	async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
		return retryWithBackoff(fn, {
			maxRetries: MAX_RETRIES,
			baseDelayMs: RETRY_BASE_DELAY_MS,
			isDestroyed: () => this.destroyed,
		});
	}

	throwIfDestroyed(): void {
		if (this.destroyed) throw createAbortError('Sync engine destroyed');
	}

	destroy(): void {
		this.destroyed = true;
		this.abortController.abort();
		this.stopPeriodicSync();
	}

	async periodicCheck(): Promise<void> {
		if (this.destroyed || this.checking) return;
		this.checking = true;
		try { await runPeriodicCheckWorkflow({
			...this.dependencies,
			getConsecutiveCheckFailures: () => this.consecutiveCheckFailures,
			setConsecutiveCheckFailures: (value: number) => {
				this.consecutiveCheckFailures = value;
			},
			getLastCheckAttempt: () => this.lastCheckAttempt,
			setLastCheckAttempt: (value: number) => {
				this.lastCheckAttempt = value;
			},
		}); } finally { this.checking = false; }
	}

	private stopPeriodicSync(): void {
		if (!this.syncInterval) return;
		clearInterval(this.syncInterval);
		this.syncInterval = null;
	}
}
