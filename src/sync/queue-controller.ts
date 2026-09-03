import type { TAbstractFile } from 'obsidian';
import type { PreparedUpload, SyncResult, SyncState } from './types';
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

export interface SyncQueueControllerContext {
	api: QueueFlushContext['api'];
	getLocalManifest(): QueueFlushContext['localManifest'];
	markdownBaseCache?: QueueFlushContext['markdownBaseCache'];
	shouldIgnore(path: string): boolean;
	updateState(updates: Partial<SyncState>): void;
	isDestroyed(): boolean;
	currentStatus(): SyncState['status'];
	prepareUploadFromPath(path: string): Promise<PreparedUpload | null>;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
	getModifiedIso(path: string, fallbackMtime?: number): Promise<string>;
	getDebounceDelayMs(): number;
	uploadConcurrency: number;
	maxDebounceWaitMs: number;
	reconcile(queueKeys: string[]): Promise<SyncResult>;
	onFlushResult(result: SyncResult): void | Promise<void>;
}

export class SyncQueueController {
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private maxWaitStart: number | null = null;
	private pendingPaths: Set<string> = new Set();
	private inFlightPaths: Set<string> = new Set();
	private pendingRevisions = new Map<string, number>();
	private nextRevision = 0;
	private reconciliationScheduled = false;
	private reconciliationPaths = new Set<string>();

	constructor(private readonly context: SyncQueueControllerContext) {}

	getPendingPaths(): string[] {
		const combined = new Set(this.pendingPaths);
		for (const path of this.inFlightPaths) combined.add(path);
		return Array.from(combined);
	}

	getPendingPathCount(): number {
		return this.pendingPaths.size;
	}

	onFileChange(file: TAbstractFile): void {
		queueOnFileChange(this.getQueueEventContext(), file);
	}

	onFileDelete(file: TAbstractFile): void {
		queueOnFileDelete(this.getQueueEventContext(), file);
	}

	onFileRename(file: TAbstractFile, oldPath: string): void {
		queueOnFileRename(this.getQueueEventContext(), file, oldPath);
	}

	snapshotPendingRevisions(): ReadonlyMap<string, number> {
		return new Map(this.pendingRevisions);
	}

	clearSyncedPendingPaths(result: SyncResult, revisionSnapshot?: ReadonlyMap<string, number>): void {
		clearSyncedQueuePaths(this.getQueueReconcileContext(), result, revisionSnapshot);
	}

	destroy(): void {
		this.clearDebounceTimer();
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
			},
			clearPending: (path: string) => {
				this.pendingRevisions.delete(path);
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
			pendingPaths: this.pendingPaths,
			inFlightPaths: this.inFlightPaths,
			pendingRevisions: this.pendingRevisions,
			api: this.context.api,
			localManifest: this.context.getLocalManifest(),
			updateState: (updates: Partial<SyncState>) => this.context.updateState(updates),
			isDestroyed: () => this.context.isDestroyed(),
			currentStatus: () => this.context.currentStatus(),
			markdownBaseCache: this.context.markdownBaseCache,
			prepareUploadFromPath: (path: string) => this.context.prepareUploadFromPath(path),
			runConcurrent: <T>(tasks: Array<() => Promise<T>>, concurrency: number) =>
				this.context.runConcurrent(tasks, concurrency),
			getModifiedIso: (path: string, fallbackMtime?: number) =>
				this.context.getModifiedIso(path, fallbackMtime),
			triggerDebouncedSync: () => this.debouncedSync(),
			requestReconciliation: (queueKeys: string[]) => this.requestReconciliation(queueKeys),
			onFlushResult: (result: SyncResult) => this.context.onFlushResult(result),
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

	private debouncedSync(): void {
		runDebouncedQueueSync(
			this.getQueueDebounceContext(),
			this.context.getDebounceDelayMs(),
			this.context.maxDebounceWaitMs,
		);
	}

	private async processPendingChanges(): Promise<void> {
		await flushPendingQueueChanges(this.getQueueFlushContext(), this.context.uploadConcurrency);
	}

	private requestReconciliation(queueKeys: string[]): void {
		for (const queueKey of queueKeys) this.reconciliationPaths.add(queueKey);
		if (this.reconciliationScheduled || this.context.isDestroyed()) return;
		this.reconciliationScheduled = true;
		queueMicrotask(() => {
			this.reconciliationScheduled = false;
			if (this.context.isDestroyed()) return;
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
