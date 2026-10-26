import type { SyncResult, SyncState } from '../types';
import { createAbortError, isAbortError } from '../abort';
import { notifyConflicts } from '../conflict/conflict';
import { retryWithBackoff, runConcurrentTasks } from '../concurrency';
import { createLogger } from '../logger';
import { errorMessage } from '../../platform/logger';

const logger = createLogger('SyncEngine');

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_CHECK_BACKOFF_MULTIPLIER = 32;
// Local-only content checks while automatic sync is off (the default interval).
export const LOCAL_CONTENT_CHECK_INTERVAL_MS = 300_000;

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
		try { await this.runPeriodicCheck(); } finally { this.checking = false; }
	}

	private async runPeriodicCheck(): Promise<void> {
		const dependencies = this.dependencies;
		if (dependencies.getStatus() === 'syncing' || dependencies.automaticSyncEnabled?.() === false) return;
		if (!dependencies.apiConfigured()) return;

		if (this.consecutiveCheckFailures > 0) {
			const multiplier = Math.min(
				2 ** (this.consecutiveCheckFailures - 1),
				MAX_CHECK_BACKOFF_MULTIPLIER,
			);
			const backoffMs = dependencies.getSyncIntervalSeconds() * 1000 * multiplier;
			if (Date.now() - this.lastCheckAttempt < backoffMs) {
				return;
			}
		}
		this.lastCheckAttempt = Date.now();

		try {
			const { hasChanges, cursorExpired } = await dependencies.checkForChanges(dependencies.getLastSeq());
			// A sync walks the vault itself, so only look for missed local edits
			// when nothing else would start one.
			const syncNeeded = hasChanges || cursorExpired || dependencies.getPendingPathCount() > 0
				|| await dependencies.hasLocalFileChanges();

			if (!syncNeeded) {
				logger.debug('Periodic check: no changes');
				this.consecutiveCheckFailures = 0;
				dependencies.onCheckSuccess();
				return;
			}

			// A queue flush may have started while this check awaited; it covers these changes.
			if (dependencies.automaticSyncEnabled?.() === false || dependencies.getStatus() === 'syncing') return;
			logger.info('Periodic check: changes detected, running sync');
			const result = await dependencies.sync();
			if (result.outcome === 'cancelled') return;
			notifyConflicts(result.conflicts);
			this.consecutiveCheckFailures = result.success ? 0 : this.consecutiveCheckFailures + 1;
		} catch (error) {
			if (isAbortError(error)) return;
			const failures = this.consecutiveCheckFailures + 1;
			const multiplier = Math.min(2 ** (failures - 1), MAX_CHECK_BACKOFF_MULTIPLIER);
			this.consecutiveCheckFailures = failures;
			dependencies.onCheckFailure(error);
			logger.warn(
				`Periodic check failed (attempt ${failures}, next in ~${multiplier}x interval):`,
				errorMessage(error),
			);
		}
	}

	private stopPeriodicSync(): void {
		if (!this.syncInterval) return;
		clearInterval(this.syncInterval);
		this.syncInterval = null;
	}
}
