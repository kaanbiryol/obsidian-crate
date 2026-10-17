import { pendingChangeKey, decodePendingChange } from './pending-change';
import type { TAbstractFile } from 'obsidian';
import type { PreparedUpload, SyncResult, SyncState } from './types';
import { createEmptySyncResult } from './sync-result';
import {
	clearSyncedPendingPaths as clearSyncedQueuePaths,
	debouncedSync as runDebouncedQueueSync,
	onFileChange as queueOnFileChange,
	onFileDelete as queueOnFileDelete,
	onFileRename as queueOnFileRename,
	type QueueDebounceContext,
	type QueueEventContext,
	type QueueReconcileContext,
} from './queue';
import {
	processPendingChanges as flushPendingQueueChanges,
	type QueueFlushContext,
} from './queue-flush';
import type { QueueFlushBatch } from './queue-flush-types';

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
		queueOnFileChange(this.getQueueEventContext(), file);
	}

	onFileDelete(file: Pick<TAbstractFile, 'path'>): void {
		queueOnFileDelete(this.getQueueEventContext(), file);
	}

	onFileRename(file: TAbstractFile, oldPath: string): void {
		queueOnFileRename(this.getQueueEventContext(), file, oldPath);
	}

	snapshotPendingRevisions(): ReadonlyMap<string, number> {
		return new Map(this.pendingRevisions);
	}

	clearSyncedPendingPaths(result: SyncResult, revisionSnapshot: ReadonlyMap<string, number>): void {
		clearSyncedQueuePaths(this.getQueueReconcileContext(), result, revisionSnapshot);
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

	private getQueueEventContext(): QueueEventContext {
		return {
			pendingPaths: this.pendingPaths,
			shouldIgnore: (path: string) => this.context.shouldIgnore(path),
			markPending: (path: string) => {
				this.nextRevision += 1;
				this.pendingRevisions.set(path, this.nextRevision);
				this.verificationKeys.add(path);
			},
			clearPending: (path: string) => {
				this.pendingRevisions.delete(path);
				this.verificationKeys.delete(path);
			},
			triggerDebouncedSync: () => this.debouncedSync(),
		};
	}

	private getQueueDebounceContext(): QueueDebounceContext {
		return {
			pendingPaths: this.pendingPaths,
			isDestroyed: () => this.context.isDestroyed(),
			getDebounceTimer: () => this.debounceTimer,
			setDebounceTimer: (timer: ReturnType<typeof setTimeout> | null) => {
				this.debounceTimer = timer;
			},
			getMaxWaitStart: () => this.maxWaitStart,
			setMaxWaitStart: (time: number | null) => {
				this.maxWaitStart = time;
			},
			updateState: (updates: Partial<SyncState>) => this.context.updateState(updates),
			processPendingChanges: () => this.processPendingChanges(),
		};
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

	private getQueueReconcileContext(): QueueReconcileContext {
		return {
			pendingPaths: this.pendingPaths,
			pendingRevisions: this.pendingRevisions,
			clearDebounceTimer: this.clearDebounceTimer.bind(this),
			updateState: (updates: Partial<SyncState>) => this.context.updateState(updates),
		};
	}

	settingsChanged(): void {
		this.clearDebounceTimer();
		if (this.pendingPaths.size > 0) this.debouncedSync();
	}

	private debouncedSync(): void {
		this.context.updateState({ pendingChanges: this.pendingPaths.size });
		this.schedulePendingVerification();
		if (this.context.automaticSyncEnabled?.() === false) return;
		runDebouncedQueueSync(
			this.getQueueDebounceContext(),
			this.context.getDebounceDelayMs(),
			this.context.maxDebounceWaitMs,
		);
	}

	/** Offline or failing flushes back off exponentially to five minutes, so a
	 * dropped connection does not re-read pending files every few seconds. A new
	 * local event still schedules an ordinary debounced attempt. */
	private retryAfterFailure(): void {
		this.consecutiveFailures++;
		this.context.updateState({ pendingChanges: this.pendingPaths.size });
		if (this.context.automaticSyncEnabled?.() === false) return;
		const delay = Math.min(this.context.getDebounceDelayMs() * 2 ** (this.consecutiveFailures - 1), MAX_RETRY_DELAY_MS);
		runDebouncedQueueSync(this.getQueueDebounceContext(), delay);
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
