import type { TAbstractFile } from 'obsidian';
import { createLogger, errorMessage } from '../plugin/logger';
import type { PreparedUpload, SyncResult, SyncState } from '../plugin/types';
import {
	clearSyncedPendingPaths as clearSyncedQueuePaths,
	debouncedSync as runDebouncedQueueSync,
	onFileChange as queueOnFileChange,
	onFileDelete as queueOnFileDelete,
	onFileRename as queueOnFileRename,
	onRawPathChange as queueOnRawPathChange,
	processPendingChanges as flushPendingQueueChanges,
	type QueueDebounceContext,
	type QueueEventContext,
	type QueueFlushContext,
	type QueueReconcileContext,
	type RawPathKind,
} from './queue';

const logger = createLogger('SyncQueue');

export interface SyncQueueControllerContext {
	vault: QueueFlushContext['vault'];
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
	hasLocalManifestFile(path: string): boolean;
	uploadConcurrency: number;
	maxDebounceWaitMs: number;
}

export class SyncQueueController {
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private maxWaitStart: number | null = null;
	private pendingPaths: Set<string> = new Set();
	private inFlightPaths: Set<string> = new Set();

	constructor(private readonly context: SyncQueueControllerContext) {}

	getPendingPaths(): string[] {
		const combined = new Set(this.pendingPaths);
		for (const path of this.inFlightPaths) combined.add(path);
		return Array.from(combined);
	}

	getPendingPathCount(): number {
		return this.pendingPaths.size;
	}

	onRawFileEvent(path: string): void {
		void this.handleRawFileEvent(path);
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

	clearSyncedPendingPaths(result: SyncResult): void {
		clearSyncedQueuePaths(this.getQueueReconcileContext(), result);
	}

	destroy(): void {
		this.clearDebounceTimer();
		this.pendingPaths.clear();
		this.inFlightPaths.clear();
	}

	private async handleRawFileEvent(path: string): Promise<void> {
		if (this.context.isDestroyed()) return;
		const kind = await this.getRawPathKind(path);
		const wasTracked = kind === 'missing' ? this.context.hasLocalManifestFile(path) : false;
		queueOnRawPathChange(this.getQueueEventContext(), path, { kind, wasTracked });
	}

	private async getRawPathKind(path: string): Promise<RawPathKind> {
		try {
			const stat = await this.context.vault.adapter.stat(path);
			if (stat?.type === 'file') return 'file';
			if (stat?.type === 'folder') return 'folder';
			return 'missing';
		} catch (error) {
			logger.warn(
				`Raw event stat failed for ${path}:`,
				errorMessage(error),
			);
			return 'missing';
		}
	}

	private getQueueEventContext(): QueueEventContext {
		return {
			pendingPaths: this.pendingPaths,
			shouldIgnore: (path: string) => this.context.shouldIgnore(path),
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
			vault: this.context.vault,
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
		};
	}

	private getQueueReconcileContext(): QueueReconcileContext {
		return {
			pendingPaths: this.pendingPaths,
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

	private clearDebounceTimer(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.maxWaitStart = null;
	}
}
