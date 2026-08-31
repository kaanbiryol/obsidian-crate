import type { TAbstractFile } from 'obsidian';
import { TFolder } from 'obsidian';
import type { SyncResult, SyncState } from './types';

export interface QueueDebounceContext {
	pendingPaths: Set<string>;
	isDestroyed(): boolean;
	getDebounceTimer(): ReturnType<typeof setTimeout> | null;
	setDebounceTimer(timer: ReturnType<typeof setTimeout> | null): void;
	getMaxWaitStart(): number | null;
	setMaxWaitStart(time: number | null): void;
	updateState(updates: Partial<SyncState>): void;
	processPendingChanges(): Promise<void>;
}

export interface QueueEventContext {
	pendingPaths: Set<string>;
	shouldIgnore(path: string): boolean;
	markPending?(path: string): void;
	clearPending?(path: string): void;
	triggerDebouncedSync(): void;
}

export interface QueueReconcileContext {
	pendingPaths: Set<string>;
	pendingRevisions?: Map<string, number>;
	clearDebounceTimer(): void;
	updateState(updates: Partial<SyncState>): void;
}

function addPendingPath(context: QueueEventContext, path: string): void {
	const oppositePath = path.startsWith('delete:')
		? path.substring(7)
		: `delete:${path}`;
	context.pendingPaths.delete(oppositePath);
	context.clearPending?.(oppositePath);
	context.pendingPaths.add(path);
	context.markPending?.(path);
}

export function onFileChange(context: QueueEventContext, file: TAbstractFile): void {
	if (!(file instanceof TFolder) && !context.shouldIgnore(file.path)) {
		addPendingPath(context, file.path);
		context.triggerDebouncedSync();
	}
}

export function onFileDelete(context: QueueEventContext, file: TAbstractFile): void {
	if (!context.shouldIgnore(file.path)) {
		addPendingPath(context, `delete:${file.path}`);
		context.triggerDebouncedSync();
	}
}

export function onFileRename(
	context: QueueEventContext,
	file: TAbstractFile,
	oldPath: string,
): void {
	if (file instanceof TFolder) return;

	const oldIgnored = context.shouldIgnore(oldPath);
	const newIgnored = context.shouldIgnore(file.path);
	if (oldIgnored && newIgnored) return;

	if (!oldIgnored) {
		addPendingPath(context, `delete:${oldPath}`);
	}
	if (!newIgnored) {
		addPendingPath(context, file.path);
	}
	context.triggerDebouncedSync();
}

export function debouncedSync(
	context: QueueDebounceContext,
	debounceDelayMs: number,
	maxWaitMs?: number,
): void {
	if (context.isDestroyed()) return;

	context.updateState({ pendingChanges: context.pendingPaths.size });

	const existingTimer = context.getDebounceTimer();

	// Track when the first debounce call arrived (before any timer existed)
	if (!existingTimer && context.getMaxWaitStart() === null) {
		context.setMaxWaitStart(Date.now());
	}

	// If max wait exceeded, fire immediately
	const maxWaitStart = context.getMaxWaitStart();
	if (maxWaitMs !== undefined && maxWaitStart !== null && Date.now() - maxWaitStart >= maxWaitMs) {
		if (existingTimer) {
			clearTimeout(existingTimer);
		}
		context.setDebounceTimer(null);
		context.setMaxWaitStart(null);
		void context.processPendingChanges();
		return;
	}

	if (existingTimer) {
		clearTimeout(existingTimer);
	}

	const timer = setTimeout(() => {
		context.setDebounceTimer(null);
		context.setMaxWaitStart(null);
		void context.processPendingChanges();
	}, debounceDelayMs);
	context.setDebounceTimer(timer);
}

export function clearSyncedPendingPaths(
	context: QueueReconcileContext,
	result: SyncResult,
	revisionSnapshot?: ReadonlyMap<string, number>,
): void {
	if (!result.success || context.pendingPaths.size === 0) {
		return;
	}

	const previousPendingCount = context.pendingPaths.size;

	const clearIfUnchanged = (key: string) => {
		if (revisionSnapshot && context.pendingRevisions) {
			const startRevision = revisionSnapshot.get(key);
			const currentRevision = context.pendingRevisions.get(key);
			if (
				(startRevision === undefined && currentRevision !== undefined)
				|| (startRevision !== undefined && currentRevision !== startRevision)
			) return;
		}
		context.pendingPaths.delete(key);
		context.pendingRevisions?.delete(key);
	};

	for (const path of result.uploadedPaths) clearIfUnchanged(path);
	for (const path of result.downloadedPaths) clearIfUnchanged(path);
	for (const path of result.mergedPaths ?? []) clearIfUnchanged(path);
	for (const path of result.deletedPaths) clearIfUnchanged(`delete:${path}`);
	for (const queueKey of result.settledPaths) clearIfUnchanged(queueKey);

	if (context.pendingPaths.size === previousPendingCount) {
		return;
	}

	if (context.pendingPaths.size === 0) {
		context.clearDebounceTimer();
	}
	context.updateState({ pendingChanges: context.pendingPaths.size });
}
