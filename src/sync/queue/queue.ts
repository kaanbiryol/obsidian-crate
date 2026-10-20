import type { TAbstractFile } from 'obsidian';
import { TFolder } from 'obsidian';
import type { SyncResult, SyncState } from '../types';
import { pendingChangeKey, type PendingChange } from '../pending/pending-change';

export interface QueueDebounceContext {
	pendingPaths: Set<string>;
	isDestroyed(): boolean;
	getDebounceTimer(): ReturnType<typeof setTimeout> | null;
	setDebounceTimer(timer: ReturnType<typeof setTimeout> | null): void;
	getMaxWaitStart(): number | null;
	setMaxWaitStart(time: number | null): void;
	processPendingChanges(): Promise<void>;
}

export interface QueueEventContext {
	pendingPaths: Set<string>;
	shouldIgnore(path: string): boolean;
	markPending(path: string): void;
	clearPending(path: string): void;
	/** `pendingChanged` is false when the event left the pending set as it was. */
	triggerDebouncedSync(pendingChanged: boolean): void;
}

export interface QueueReconcileContext {
	pendingPaths: Set<string>;
	pendingRevisions: Map<string, number>;
	clearDebounceTimer(): void;
	updateState(updates: Partial<SyncState>): void;
}

/** Returns whether the pending set changed. */
function addPendingPath(context: QueueEventContext, change: PendingChange): boolean {
	const path = pendingChangeKey(change.kind, change.path);
	const oppositePath = pendingChangeKey(change.kind === 'delete' ? 'upload' : 'delete', change.path);
	const changed = context.pendingPaths.delete(oppositePath) || !context.pendingPaths.has(path);
	context.clearPending(oppositePath);
	context.pendingPaths.add(path);
	context.markPending(path);
	return changed;
}

export function onFileChange(context: QueueEventContext, file: Pick<TAbstractFile, 'path'>): void {
	if (!(file instanceof TFolder) && !context.shouldIgnore(file.path)) {
		context.triggerDebouncedSync(addPendingPath(context, { kind: 'upload', path: file.path }));
	}
}

export function onFileDelete(context: QueueEventContext, file: Pick<TAbstractFile, 'path'>): void {
	if (!(file instanceof TFolder) && !context.shouldIgnore(file.path)) {
		context.triggerDebouncedSync(addPendingPath(context, { kind: 'delete', path: file.path }));
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

	const deleted = !oldIgnored && addPendingPath(context, { kind: 'delete', path: oldPath });
	const uploaded = !newIgnored && addPendingPath(context, { kind: 'upload', path: file.path });
	context.triggerDebouncedSync(deleted || uploaded);
}

export function debouncedSync(
	context: QueueDebounceContext,
	debounceDelayMs: number,
	maxWaitMs?: number,
): void {
	if (context.isDestroyed()) return;

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
	revisionSnapshot: ReadonlyMap<string, number>,
): void {
	if (!result.success || context.pendingPaths.size === 0) {
		return;
	}

	const previousPendingCount = context.pendingPaths.size;

	const clearIfUnchanged = (key: string) => {
		const startRevision = revisionSnapshot.get(key);
		const currentRevision = context.pendingRevisions.get(key);
		if (currentRevision !== startRevision) return;
		context.pendingPaths.delete(key);
		context.pendingRevisions.delete(key);
	};

	for (const path of result.uploadedPaths) clearIfUnchanged(pendingChangeKey('upload', path));
	for (const path of result.downloadedPaths) clearIfUnchanged(pendingChangeKey('upload', path));
	for (const path of result.mergedPaths ?? []) clearIfUnchanged(pendingChangeKey('upload', path));
	for (const path of result.deletedPaths) clearIfUnchanged(pendingChangeKey('delete', path));
	for (const queueKey of result.settledPaths) clearIfUnchanged(queueKey);

	if (context.pendingPaths.size === previousPendingCount) {
		return;
	}

	if (context.pendingPaths.size === 0) {
		context.clearDebounceTimer();
	}
	context.updateState({ pendingChanges: context.pendingPaths.size });
}
