import { pendingChangeKey, decodePendingChange, type PendingChange } from '../pending/pending-change';
import { TFolder, type TAbstractFile } from 'obsidian';
import type { PreparedUpload, SyncResult, SyncState } from '../types';
import { createEmptySyncResult } from '../sync-result';
import {
	processPendingChanges as flushPendingQueueChanges,
	type QueueFlushContext,
} from './flush';
import type { QueueFlushBatch } from './flush-types';

export interface SyncQueueControllerContext {
	finishInitialSetup(): Promise<void>;
	uploadPreparedFiles: QueueFlushContext['uploadPreparedFiles'];
	deleteRemoteFiles: QueueFlushContext['deleteRemoteFiles'];
	automaticSyncEnabled?(): boolean;
	recoverUploads(): Promise<void>;
	api: QueueFlushContext['api'];
	getLocalManifest(): QueueFlushContext['localManifest'];
	shouldIgnore(path: string): boolean;
	updateState(updates: Partial<SyncState>): void;
	setLastSync: QueueFlushContext['setLastSync'];
	reconnectNotice: QueueFlushContext['reconnectNotice'];
	isDestroyed(): boolean;
	currentStatus(): SyncState['status'];
	verifyPendingPaths(keys: string[], isCurrent: (key: string) => boolean): Promise<string[]>;
	prepareUploadFromPath(path: string): Promise<PreparedUpload | null>;
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
	private pendingPaths: Set<string> = new Set();
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

	/** Canonical pending-change keys; decode before treating them as file paths. */
	getPendingPaths(): string[] {
		const combined = new Set(this.pendingPaths);
		for (const path of this.inFlightPaths) combined.add(path);
		return Array.from(combined);
	}

	/** `getPendingPaths().includes(key)` without copying the pending set. */
	hasPendingPath(key: string): boolean {
		return this.pendingPaths.has(key) || this.inFlightPaths.has(key);
	}

	/** `getPendingPaths().length` without copying the pending set. */
	getPendingChangeCount(): number {
		let count = this.pendingPaths.size;
		for (const path of this.inFlightPaths) if (!this.pendingPaths.has(path)) count++;
		return count;
	}

	getPendingPathCount(): number {
		return this.pendingPaths.size;
	}

	restorePendingPaths(paths: string[]): void {
		for (const key of paths) {
			const path = decodePendingChange(key).path;
			// Live events take precedence over the startup snapshot.
			if (this.pendingPaths.has(pendingChangeKey('upload', path)) || this.pendingPaths.has(pendingChangeKey('delete', path))) continue;
			if (this.context.shouldIgnore(path)) continue;
			this.pendingPaths.add(key);
			this.pendingRevisions.set(key, ++this.nextRevision);
		}
		this.context.updateState({ pendingChanges: this.pendingPaths.size });
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
		const changed = this.pendingPaths.delete(oppositePath) || !this.pendingPaths.has(path);
		this.pendingRevisions.delete(oppositePath);
		this.verificationKeys.delete(oppositePath);
		this.pendingPaths.add(path);
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
		if (!result.success || this.pendingPaths.size === 0) {
			return;
		}

		const previousPendingCount = this.pendingPaths.size;

		const clearIfUnchanged = (key: string) => {
			const startRevision = revisionSnapshot.get(key);
			const currentRevision = this.pendingRevisions.get(key);
			if (currentRevision !== startRevision) return;
			this.pendingPaths.delete(key);
			this.pendingRevisions.delete(key);
		};

		for (const path of result.uploadedPaths) clearIfUnchanged(pendingChangeKey('upload', path));
		for (const path of result.downloadedPaths) clearIfUnchanged(pendingChangeKey('upload', path));
		for (const path of result.mergedPaths ?? []) clearIfUnchanged(pendingChangeKey('upload', path));
		for (const path of result.deletedPaths) clearIfUnchanged(pendingChangeKey('delete', path));
		for (const queueKey of result.settledPaths) clearIfUnchanged(queueKey);

		if (this.pendingPaths.size === previousPendingCount) {
			return;
		}

		if (this.pendingPaths.size === 0) {
			this.clearDebounceTimer();
		}
		this.context.updateState({ pendingChanges: this.pendingPaths.size });
	}

	destroy(): void {
		this.clearDebounceTimer();
		if (this.verificationTimer !== null) clearTimeout(this.verificationTimer);
		this.verificationTimer = null;
		this.verificationKeys.clear();
		this.pendingPaths.clear();
		this.inFlightPaths.clear();
		this.pendingRevisions.clear();
		this.reconciliationScheduled = false;
		this.reconciliationPaths.clear();
	}

	private getQueueFlushContext(): QueueFlushContext {
		return {
			recoverUploads: () => this.context.recoverUploads(),
			finishInitialSetup: () => this.context.finishInitialSetup(),
			uploadPreparedFiles: (...args) => this.context.uploadPreparedFiles(...args),
			deleteRemoteFiles: (...args) => this.context.deleteRemoteFiles(...args),
			getPendingPathCount: () => this.pendingPaths.size,
			beginBatch: () => this.beginFlushBatch(),
			api: this.context.api,
			localManifest: this.context.getLocalManifest(),
			updateState: (updates: Partial<SyncState>) => this.context.updateState(updates),
			setLastSync: (value: string) => this.context.setLastSync(value),
			reconnectNotice: this.context.reconnectNotice,
			isDestroyed: () => this.context.isDestroyed(),
			currentStatus: () => this.context.currentStatus(),
			prepareUploadFromPath: (path: string) => this.context.prepareUploadFromPath(path),
			triggerDebouncedSync: () => this.debouncedSync(),
			retryAfterFailure: () => this.retryAfterFailure(),
			flushSucceeded: () => { this.consecutiveFailures = 0; },
			requestReconciliation: (queueKeys: string[]) => this.requestReconciliation(queueKeys),
			onFlushResult: (result: SyncResult) => this.context.onFlushResult(result),
		};
	}

	private beginFlushBatch(): QueueFlushBatch {
		const paths = [...this.pendingPaths];
		const revisions = new Map(paths.map(path => [path, this.pendingRevisions.get(path)]));
		for (const path of paths) {
			this.pendingPaths.delete(path);
			this.inFlightPaths.add(path);
		}
		let released = false;
		return {
			paths,
			requeue: keys => { for (const key of keys) this.pendingPaths.add(key); },
			settle: completedKeys => {
				for (const key of completedKeys) {
					if (!this.pendingPaths.has(key) && this.pendingRevisions.get(key) === revisions.get(key)) {
						this.pendingRevisions.delete(key);
					}
				}
			},
			release: () => {
				// Reporting can outlive this batch and overlap a later flush of the
				// same path. Its finalizer must release this ownership only once.
				if (released) return;
				released = true;
				for (const path of paths) this.inFlightPaths.delete(path);
			},
		};
	}

	settingsChanged(): void {
		this.clearDebounceTimer();
		if (this.pendingPaths.size > 0) this.debouncedSync();
	}

	/** Re-saving an already pending file only restarts the countdown. */
	private debouncedSync(pendingChanged = true): void {
		if (pendingChanged) this.context.updateState({ pendingChanges: this.pendingPaths.size });
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
		this.context.updateState({ pendingChanges: this.pendingPaths.size });
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
		for (const key of this.pendingPaths) this.verificationKeys.add(key);
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
			&& this.context.currentStatus() !== 'syncing' && this.pendingPaths.has(key)
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
