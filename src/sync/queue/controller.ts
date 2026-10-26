import { pendingChangeKey, decodePendingChange, type PendingChange } from '../pending/pending-change';
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

export class SyncQueueController {
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private consecutiveFailures = 0;
	private maxWaitStart: number | null = null;
	private pendingKeys: Set<string> = new Set();
	private inFlightPaths: Set<string> = new Set();
	private pendingRevisions = new Map<string, number>();
	private nextRevision = 0;
	private flushTasks = new Set<Promise<void>>();
	private reconciliationScheduled = false;
	private reconciliationPaths = new Set<string>();
	private verificationKeys = new Set<string>();
	private verificationTimer: ReturnType<typeof setTimeout> | null = null;
	private verificationTask: Promise<void> | null = null;

	constructor(private readonly context: SyncQueueControllerContext) {}

	getPendingKeys(): string[] {
		const combined = new Set(this.pendingKeys);
		for (const path of this.inFlightPaths) combined.add(path);
		return Array.from(combined);
	}

	/** `getPendingKeys().includes(key)` without copying the pending set. */
	hasPendingKey(key: string): boolean {
		return this.pendingKeys.has(key) || this.inFlightPaths.has(key);
	}

	/** `getPendingKeys().length` without copying the pending set. */
	getPendingChangeCount(): number {
		let count = this.pendingKeys.size;
		for (const path of this.inFlightPaths) if (!this.pendingKeys.has(path)) count++;
		return count;
	}

	getPendingPathCount(): number {
		return this.pendingKeys.size;
	}

	restorePendingPaths(paths: string[]): void {
		for (const key of paths) {
			const path = decodePendingChange(key).path;
			// Live events take precedence over the startup snapshot.
			if (this.pendingKeys.has(pendingChangeKey('upload', path)) || this.pendingKeys.has(pendingChangeKey('delete', path))) continue;
			if (this.context.shouldIgnore(path)) continue;
			this.pendingKeys.add(key);
			this.pendingRevisions.set(key, ++this.nextRevision);
		}
		this.context.updateState({ pendingChanges: this.pendingKeys.size });
	}

	/** Like `restorePendingPaths`, then verifies and flushes the keys as live events. */
	restoreDroppedEvents(keys: string[]): void {
		if (!keys.length) return;
		this.restorePendingPaths(keys);
		for (const key of keys) if (this.pendingKeys.has(key)) this.verificationKeys.add(key);
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
		const path = pendingChangeKey(change.kind, change.path);
		const oppositePath = pendingChangeKey(change.kind === 'delete' ? 'upload' : 'delete', change.path);
		const changed = this.pendingKeys.delete(oppositePath) || !this.pendingKeys.has(path);
		this.pendingRevisions.delete(oppositePath);
		this.verificationKeys.delete(oppositePath);
		this.pendingKeys.add(path);
		this.nextRevision += 1;
		this.pendingRevisions.set(path, this.nextRevision);
		this.verificationKeys.add(path);
		return changed;
	}

	snapshotPendingRevisions(): ReadonlyMap<string, number> {
		return new Map(this.pendingRevisions);
	}

	/** Settles keys a successful result covered, unless a newer event arrived after
	 * `revisionSnapshot` was taken. */
	clearSyncedPendingPaths(result: SyncResult, revisionSnapshot: ReadonlyMap<string, number>): void {
		if (!result.success || this.pendingKeys.size === 0) {
			return;
		}

		const previousPendingCount = this.pendingKeys.size;

		const clearIfUnchanged = (key: string) => {
			const startRevision = revisionSnapshot.get(key);
			const currentRevision = this.pendingRevisions.get(key);
			if (currentRevision !== startRevision) return;
			this.pendingKeys.delete(key);
			this.pendingRevisions.delete(key);
		};

		for (const path of result.uploadedPaths) clearIfUnchanged(pendingChangeKey('upload', path));
		for (const path of result.downloadedPaths) clearIfUnchanged(pendingChangeKey('upload', path));
		for (const path of result.mergedPaths ?? []) clearIfUnchanged(pendingChangeKey('upload', path));
		for (const path of result.deletedPaths) clearIfUnchanged(pendingChangeKey('delete', path));
		for (const queueKey of result.settledPaths) clearIfUnchanged(queueKey);

		if (this.pendingKeys.size === previousPendingCount) {
			return;
		}

		if (this.pendingKeys.size === 0) {
			this.clearDebounceTimer();
		}
		this.context.updateState({ pendingChanges: this.pendingKeys.size });
	}

	destroy(): void {
		this.clearDebounceTimer();
		if (this.verificationTimer !== null) clearTimeout(this.verificationTimer);
		this.verificationTimer = null;
		this.verificationKeys.clear();
		this.pendingKeys.clear();
		this.inFlightPaths.clear();
		this.pendingRevisions.clear();
		this.reconciliationScheduled = false;
		this.reconciliationPaths.clear();
	}

	private getQueueFlushContext(): QueueFlushContext {
		return {
			...this.context,
			getPendingPathCount: () => this.pendingKeys.size,
			beginBatch: () => this.beginFlushBatch(),
			triggerDebouncedSync: () => this.debouncedSync(),
			retryAfterFailure: () => this.retryAfterFailure(),
			flushSucceeded: () => { this.consecutiveFailures = 0; },
			requestReconciliation: (queueKeys: string[]) => this.requestReconciliation(queueKeys),
		};
	}

	private beginFlushBatch(): QueueFlushBatch {
		const paths = [...this.pendingKeys];
		const revisions = new Map(paths.map(path => [path, this.pendingRevisions.get(path)]));
		for (const path of paths) {
			this.pendingKeys.delete(path);
			this.inFlightPaths.add(path);
		}
		let released = false;
		return {
			paths,
			requeue: keys => { for (const key of keys) this.pendingKeys.add(key); },
			release: () => {
				// Reporting can outlive this batch and overlap a later flush of the
				// same path. Its finalizer must release this ownership only once.
				if (released) return;
				released = true;
				for (const path of paths) {
					this.inFlightPaths.delete(path);
					// Every key not requeued is settled, including unchanged files the
					// flush skipped; a newer event keeps its own revision.
					if (!this.pendingKeys.has(path) && this.pendingRevisions.get(path) === revisions.get(path)) {
						this.pendingRevisions.delete(path);
					}
				}
			},
		};
	}

	settingsChanged(): void {
		this.clearDebounceTimer();
		if (this.pendingKeys.size > 0) this.debouncedSync();
	}

	/** Re-saving an already pending file only restarts the countdown. */
	private debouncedSync(pendingChanged = true): void {
		if (pendingChanged) this.context.updateState({ pendingChanges: this.pendingKeys.size });
		this.schedulePendingVerification();
		if (this.context.automaticSyncEnabled?.() === false) return;
		this.scheduleFlush(this.context.getDebounceDelayMs(), this.context.maxDebounceWaitMs);
	}

	/** Restarts the quiet-period timer; once `maxWaitMs` has passed since the first
	 * scheduled flush, flushes immediately instead. */
	private scheduleFlush(debounceDelayMs: number, maxWaitMs?: number): void {
		if (this.context.isDestroyed()) return;

		const existingTimer = this.debounceTimer;

		// Track when the first debounce call arrived (before any timer existed)
		if (!existingTimer && this.maxWaitStart === null) {
			this.maxWaitStart = Date.now();
		}

		// If max wait exceeded, fire immediately
		const maxWaitStart = this.maxWaitStart;
		if (maxWaitMs !== undefined && maxWaitStart !== null && Date.now() - maxWaitStart >= maxWaitMs) {
			if (existingTimer) {
				clearTimeout(existingTimer);
			}
			this.debounceTimer = null;
			this.maxWaitStart = null;
			void this.processPendingChanges();
			return;
		}

		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.maxWaitStart = null;
			void this.processPendingChanges();
		}, debounceDelayMs);
	}

	/** Offline or failing flushes back off exponentially to five minutes, so a
	 * dropped connection does not re-read pending files every few seconds. A new
	 * local event still schedules an ordinary debounced attempt. */
	private retryAfterFailure(): void {
		this.consecutiveFailures++;
		this.context.updateState({ pendingChanges: this.pendingKeys.size });
		if (this.context.automaticSyncEnabled?.() === false) return;
		const delay = Math.min(this.context.getDebounceDelayMs() * 2 ** (this.consecutiveFailures - 1), MAX_RETRY_DELAY_MS);
		this.scheduleFlush(delay);
	}

	private async processPendingChanges(): Promise<void> {
		if (this.context.automaticSyncEnabled?.() === false) return;
		const task = flushPendingQueueChanges(this.getQueueFlushContext());
		this.flushTasks.add(task);
		try { await task; } finally { this.flushTasks.delete(task); }
	}

	async waitForIdle(): Promise<void> {
		await Promise.allSettled([...this.flushTasks, this.verificationTask]);
	}

	/** Resume checks deferred by a sync, including events emitted by downloads. */
	recheckPendingPaths(): void {
		for (const key of this.pendingKeys) this.verificationKeys.add(key);
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
			&& this.context.currentStatus() !== 'syncing' && this.pendingKeys.has(key)
			&& !this.inFlightPaths.has(key) && this.pendingRevisions.get(key) === revisions.get(key);
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
