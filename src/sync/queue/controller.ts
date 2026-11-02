import { pendingChangeKey, decodePendingChange, type PendingChange } from '../pending/pending-change';
import { PendingSet } from './pending-set';
import { TFolder, type TAbstractFile } from 'obsidian';
import type { SyncResult } from '../types';
import { createEmptySyncResult } from '../sync-result';
import {
	processPendingChanges as flushPendingQueueChanges,
	type QueueFlushBatch,
	type QueueFlushContext,
} from './flush';

/** The engine supplies the flush members; the controller adds its batch and scheduling ones. */
export interface SyncQueueControllerContext extends Pick<QueueFlushContext,
	| 'finishInitialSetup' | 'uploadPreparedFiles' | 'deleteRemoteFiles' | 'recoverUploads' | 'api' | 'localManifest'
	| 'updateState' | 'setLastSync' | 'reconnectNotice' | 'isDestroyed' | 'currentStatus' | 'prepareUploadFromPath'> {
	automaticSyncEnabled?(): boolean;
	shouldIgnore(path: string): boolean;
	verifyPendingPaths(keys: string[], isCurrent: (key: string) => boolean): Promise<string[]>;
	getDebounceDelayMs(): number;
	maxDebounceWaitMs: number;
	reconcile(queueKeys: string[]): Promise<SyncResult>;
	onFlushResult(result: SyncResult): void | Promise<void>;
}

const MAX_RETRY_DELAY_MS = 5 * 60_000;
/** Each upload sends the whole file again, so to save bandwidth an automatic flush
 * holds back an edited synced file of this size until it has been quiet for a
 * minute, for at most five minutes. The server already coalesces the history copies
 * these uploads replace. Sync now, periodic, foreground and full syncs still upload
 * it at once. */
const LARGE_UPLOAD_BYTES = 1024 * 1024;
const LARGE_UPLOAD_QUIET_MS = 60_000;
const LARGE_UPLOAD_MAX_WAIT_MS = 5 * 60_000;

export class SyncQueueController {
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private consecutiveFailures = 0;
	private maxWaitStart: number | null = null;
	private readonly pending = new PendingSet();
	private flushTasks = new Set<Promise<void>>();
	private reconciliationScheduled = false;
	private reconciliationPaths = new Set<string>();
	private verificationKeys = new Set<string>();
	private verificationTimer: ReturnType<typeof setTimeout> | null = null;
	private verificationTask: Promise<void> | null = null;

	constructor(private readonly context: SyncQueueControllerContext) {}

	getPendingKeys(): string[] {
		return this.pending.keys();
	}

	/** `getPendingKeys().includes(key)` without copying the pending set. */
	hasPendingKey(key: string): boolean {
		return this.pending.has(key);
	}

	/** `getPendingKeys().length` without copying the pending set. */
	getPendingChangeCount(): number {
		return this.pending.count();
	}

	getPendingPathCount(): number {
		return this.pending.queuedCount;
	}

	restorePendingPaths(paths: string[]): void {
		// Live events take precedence over the startup snapshot.
		for (const key of paths) if (!this.context.shouldIgnore(decodePendingChange(key).path)) this.pending.restore(key);
		this.context.updateState({ pendingChanges: this.pending.queuedCount });
	}

	/** Like `restorePendingPaths`, then verifies and flushes the keys as live events. */
	restoreDroppedEvents(keys: string[]): void {
		if (!keys.length) return;
		this.restorePendingPaths(keys);
		for (const key of keys) if (this.pending.queuedKeys().has(key)) this.verificationKeys.add(key);
		this.debouncedSync(false);
	}

	onFileChange(file: Pick<TAbstractFile, 'path'>): void {
		if (!(file instanceof TFolder) && !this.context.shouldIgnore(file.path)) {
			this.debouncedSync(this.addPendingPath({ kind: 'upload', path: file.path }));
		}
	}

	onFileDelete(file: Pick<TAbstractFile, 'path'>): void {
		if (!(file instanceof TFolder) && !this.context.shouldIgnore(file.path)) {
			this.debouncedSync(this.addPendingPath({ kind: 'delete', path: file.path }));
		}
	}

	onFileRename(file: TAbstractFile, oldPath: string): void {
		if (file instanceof TFolder) return;

		const oldIgnored = this.context.shouldIgnore(oldPath);
		const newIgnored = this.context.shouldIgnore(file.path);
		if (oldIgnored && newIgnored) return;

		const deleted = !oldIgnored && this.addPendingPath({ kind: 'delete', path: oldPath });
		const uploaded = !newIgnored && this.addPendingPath({ kind: 'upload', path: file.path });
		this.debouncedSync(deleted || uploaded);
	}

	/** Records a new revision for the change and drops the opposite operation for
	 * its path. Returns whether the pending set changed. */
	private addPendingPath(change: PendingChange): boolean {
		const { key, opposite, changed } = this.pending.add(change, Date.now());
		this.verificationKeys.delete(opposite);
		this.verificationKeys.add(key);
		return changed;
	}

	snapshotPendingRevisions(): ReadonlyMap<string, number> {
		return this.pending.snapshotRevisions();
	}

	/** Settles keys a successful result covered, unless a newer event arrived after
	 * `revisionSnapshot` was taken. */
	clearSyncedPendingPaths(result: SyncResult, revisionSnapshot: ReadonlyMap<string, number>): void {
		if (!result.success || this.pending.queuedCount === 0) {
			return;
		}

		const previousPendingCount = this.pending.queuedCount;
		const clearIfUnchanged = (key: string) => this.pending.settleIfUnchanged(key, revisionSnapshot);

		for (const path of result.uploadedPaths) clearIfUnchanged(pendingChangeKey('upload', path));
		for (const path of result.downloadedPaths) clearIfUnchanged(pendingChangeKey('upload', path));
		for (const path of result.mergedPaths ?? []) clearIfUnchanged(pendingChangeKey('upload', path));
		for (const path of result.deletedPaths) clearIfUnchanged(pendingChangeKey('delete', path));
		for (const queueKey of result.settledPaths) clearIfUnchanged(queueKey);

		if (this.pending.queuedCount === previousPendingCount) {
			return;
		}

		if (this.pending.queuedCount === 0) {
			this.clearDebounceTimer();
		}
		this.context.updateState({ pendingChanges: this.pending.queuedCount });
	}

	destroy(): void {
		this.clearDebounceTimer();
		if (this.verificationTimer !== null) clearTimeout(this.verificationTimer);
		this.verificationTimer = null;
		this.verificationKeys.clear();
		this.pending.clear();
		this.reconciliationScheduled = false;
		this.reconciliationPaths.clear();
	}

	private getQueueFlushContext(): QueueFlushContext {
		return {
			...this.context,
			getPendingPathCount: () => this.pending.queuedCount,
			beginBatch: () => this.beginFlushBatch(),
			triggerDebouncedSync: () => this.debouncedSync(),
			retryAfterFailure: () => this.retryAfterFailure(),
			flushSucceeded: () => { this.consecutiveFailures = 0; },
			requestReconciliation: (queueKeys: string[]) => this.requestReconciliation(queueKeys),
		};
	}

	private beginFlushBatch(): QueueFlushBatch {
		const now = Date.now();
		const batch = this.pending.takeBatch(key => this.largeUploadReadyAt(key, now) === null);
		this.scheduleHeldUploads(now);
		return batch;
	}

	settingsChanged(): void {
		this.clearDebounceTimer();
		if (this.pending.queuedCount > 0) this.debouncedSync();
	}

	/** Re-saving an already pending file only restarts the countdown. */
	private debouncedSync(pendingChanged = true): void {
		if (pendingChanged) this.context.updateState({ pendingChanges: this.pending.queuedCount });
		this.schedulePendingVerification();
		if (this.context.automaticSyncEnabled?.() === false) return;
		this.scheduleFlush(this.context.getDebounceDelayMs(), this.context.maxDebounceWaitMs);
	}

	/** Restarts the quiet-period timer; once `maxWaitMs` has passed since the first
	 * scheduled flush, flushes immediately instead. */
	private scheduleFlush(debounceDelayMs: number, maxWaitMs?: number): void {
		if (this.context.isDestroyed()) return;

		const existingTimer = this.debounceTimer;

		// Track when the first debounce call arrived. A timer for a held large upload
		// does not start the maximum wait, so the first event after it does.
		if (this.maxWaitStart === null) {
			this.maxWaitStart = Date.now();
		}

		// If max wait exceeded, fire immediately
		const maxWaitStart = this.maxWaitStart;
		if (maxWaitMs !== undefined && maxWaitStart !== null && Date.now() - maxWaitStart >= maxWaitMs) {
			if (existingTimer) {
				clearTimeout(existingTimer);
			}
			this.flushNow();
			return;
		}

		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		this.debounceTimer = setTimeout(this.flushNow, debounceDelayMs);
	}

	/** Ends the current wait and flushes. */
	private readonly flushNow = (): void => {
		this.debounceTimer = null;
		this.maxWaitStart = null;
		void this.processPendingChanges();
	};

	/** Offline or failing flushes back off exponentially to five minutes, so a
	 * dropped connection does not re-read pending files every few seconds. A new
	 * local event still schedules an ordinary debounced attempt. */
	private retryAfterFailure(): void {
		this.consecutiveFailures++;
		this.context.updateState({ pendingChanges: this.pending.queuedCount });
		if (this.context.automaticSyncEnabled?.() === false) return;
		const delay = Math.min(this.context.getDebounceDelayMs() * 2 ** (this.consecutiveFailures - 1), MAX_RETRY_DELAY_MS);
		this.scheduleFlush(delay);
	}

	/** When a held-back large upload becomes due, or null when `key` is not held. */
	private largeUploadReadyAt(key: string, now: number): number | null {
		const times = this.pending.timesOf(key);
		const change = decodePendingChange(key);
		if (!times || change.kind !== 'upload' || (this.context.localManifest.getEntry(change.path)?.size ?? 0) < LARGE_UPLOAD_BYTES) return null;
		const readyAt = Math.min(times.last + LARGE_UPLOAD_QUIET_MS, times.first + LARGE_UPLOAD_MAX_WAIT_MS);
		return readyAt > now ? readyAt : null;
	}

	/** Schedules a flush for the earliest held-back upload; returns whether any is held. */
	private scheduleHeldUploads(now: number): boolean {
		let readyAt = Infinity;
		for (const key of this.pending.queuedKeys()) readyAt = Math.min(readyAt, this.largeUploadReadyAt(key, now) ?? Infinity);
		if (readyAt === Infinity) return false;
		if (!this.debounceTimer) this.debounceTimer = setTimeout(this.flushNow, readyAt - now);
		return true;
	}

	private async processPendingChanges(): Promise<void> {
		if (this.context.automaticSyncEnabled?.() === false) return;
		const now = Date.now();
		if ([...this.pending.queuedKeys()].every(key => this.largeUploadReadyAt(key, now) !== null) && this.scheduleHeldUploads(now)) return;
		const task = flushPendingQueueChanges(this.getQueueFlushContext());
		this.flushTasks.add(task);
		try { await task; } finally { this.flushTasks.delete(task); }
	}

	async waitForIdle(): Promise<void> {
		await Promise.allSettled([...this.flushTasks, this.verificationTask]);
	}

	/** Resume checks deferred by a sync, including events emitted by downloads. */
	recheckPendingPaths(): void {
		for (const key of this.pending.queuedKeys()) this.verificationKeys.add(key);
		this.schedulePendingVerification();
	}

	private schedulePendingVerification(): void {
		if (!this.verificationKeys.size || this.verificationTimer !== null || this.verificationTask
			|| this.context.isDestroyed() || this.context.currentStatus() === 'syncing') return;
		// Coalesce bursts independently of the automatic network-sync preference.
		this.verificationTimer = setTimeout(() => {
			this.verificationTimer = null;
			const task = this.verifyPendingChanges();
			this.verificationTask = task;
			void task.catch(() => {
				// Failed checkpoint writes leave the queue intact for the next sync.
			}).finally(() => {
				this.verificationTask = null;
				this.schedulePendingVerification();
			});
		}, 250);
	}

	private async verifyPendingChanges(): Promise<void> {
		if (this.context.isDestroyed() || this.context.currentStatus() === 'syncing') return;
		const keys = [...this.verificationKeys];
		this.verificationKeys.clear();
		const revisions = this.snapshotPendingRevisions();
		const isCurrent = (key: string) => !this.context.isDestroyed()
			&& this.context.currentStatus() !== 'syncing' && this.pending.isUnchangedSince(key, revisions);
		const result = createEmptySyncResult();
		result.settledPaths = await this.context.verifyPendingPaths(keys, isCurrent);
		this.clearSyncedPendingPaths(result, revisions);
	}

	private requestReconciliation(queueKeys: string[]): void {
		for (const queueKey of queueKeys) this.reconciliationPaths.add(queueKey);
		if (this.reconciliationScheduled || this.context.isDestroyed()) return;
		this.reconciliationScheduled = true;
		queueMicrotask(() => {
			this.reconciliationScheduled = false;
			if (this.context.isDestroyed() || this.context.automaticSyncEnabled?.() === false) return;
			const paths = [...this.reconciliationPaths];
			this.reconciliationPaths.clear();
			void this.context.reconcile(paths).catch(() => {
				// Sync state already reports the failure; periodic/manual sync can retry.
			});
		});
	}

	private clearDebounceTimer(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.maxWaitStart = null;
	}
}
