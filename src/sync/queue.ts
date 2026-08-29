import type { TAbstractFile, Vault } from 'obsidian';
import { TFolder } from 'obsidian';
import { createLogger, errorMessage } from '../plugin/logger';
import { isMarkdownPath } from './markdown-base-cache';
import { isAbortError } from './abort';
import { isRetryableSyncError } from './engine-utils';
import type { PreparedUpload, SyncResult, SyncState } from '../plugin/types';

const logger = createLogger('SyncQueue');
const RETRYABLE_DELETE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

interface QueueApi {
	isConfigured(): boolean;
	uploadFile(
		path: string,
		content: ArrayBuffer,
		hash: string,
		size: number,
		contentType: string,
		expectedHash: string | null,
	): Promise<{ success: boolean; path: string; hash?: string; error?: string }>;
	deleteFile(path: string, expectedHash: string): Promise<{ success: boolean; path: string }>;
	batchDelete(paths: string[], expectedHashes?: Record<string, string>): Promise<{
		success: boolean;
		deleted: string[];
		errors?: Array<{ path: string; error: string; status?: number }>;
	}>;
}

interface QueueManifest {
	getEntry?(path: string): { hash: string; size: number; modified: string } | undefined;
	setEntry(path: string, entry: { hash: string; size: number; modified: string }): void;
	removeEntry(path: string): void;
	save(): Promise<void>;
}

interface QueueMarkdownBaseCache {
	putBase(path: string, hash: string, content: ArrayBuffer): Promise<void>;
}

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

export type RawPathKind = 'file' | 'folder' | 'missing';

interface RawPathChangeOptions {
	kind?: RawPathKind;
	wasTracked?: boolean;
}

export interface QueueFlushContext {
	pendingPaths: Set<string>;
	inFlightPaths: Set<string>;
	pendingRevisions?: Map<string, number>;
	vault: Vault;
	api: QueueApi;
	localManifest: QueueManifest;
	updateState(updates: Partial<SyncState>): void;
	isDestroyed(): boolean;
	currentStatus(): SyncState['status'];
	markdownBaseCache?: QueueMarkdownBaseCache;
	prepareUploadFromPath(path: string): Promise<PreparedUpload | null>;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
	getModifiedIso(path: string, fallbackMtime?: number): Promise<string>;
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

export function onRawPathChange(
	context: QueueEventContext,
	path: string,
	options: RawPathChangeOptions = {},
): void {
	if (context.shouldIgnore(path)) return;

	const kind = options.kind ?? 'file';
	if (kind === 'folder') return;

	if (kind === 'missing') {
		if (!options.wasTracked) return;
		addPendingPath(context, `delete:${path}`);
		context.triggerDebouncedSync();
		return;
	}

	addPendingPath(context, path);
	context.triggerDebouncedSync();
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

export async function processPendingChanges(
	context: QueueFlushContext,
	uploadConcurrency: number,
): Promise<void> {
	if (context.isDestroyed()) return;

	if (context.pendingPaths.size === 0) {
		context.updateState({ pendingChanges: 0 });
		return;
	}
	if (context.currentStatus() === 'syncing') {
		context.updateState({ pendingChanges: context.pendingPaths.size });
		context.triggerDebouncedSync();
		return;
	}
	if (!context.api.isConfigured()) {
		context.updateState({ pendingChanges: context.pendingPaths.size });
		return;
	}

	const paths = Array.from(context.pendingPaths);
	const pendingRevisions = context.pendingRevisions;
	const revisionSnapshot = new Map(paths.map((path) => [path, pendingRevisions?.get(path)] as const));
	const completedQueueKeys = new Set<string>();
	const clearCompletedRevisions = () => {
		for (const path of completedQueueKeys) {
			const startingRevision = revisionSnapshot.get(path);
			if (
				!context.pendingPaths.has(path)
				&& pendingRevisions?.get(path) === startingRevision
			) {
				pendingRevisions?.delete(path);
			}
		}
	};
	for (const path of paths) {
		context.pendingPaths.delete(path);
		context.inFlightPaths.add(path);
	}

	logger.info(`Processing ${paths.length} pending changes`);
	context.updateState({ status: 'syncing', pendingChanges: context.pendingPaths.size });

	try {
		const uploads: PreparedUpload[] = [];
		const deletes: Array<{ path: string; expectedHash: string }> = [];

		for (const path of paths) {
			if (path.startsWith('delete:')) {
				const deletedPath = path.substring(7);
				const expectedHash = context.localManifest.getEntry?.(deletedPath)?.hash;
				if (!expectedHash) {
					// The path was created and removed before it ever reached the remote.
					continue;
				}
				deletes.push({ path: deletedPath, expectedHash });
				continue;
			}

			const uploadFile = await context.prepareUploadFromPath(path);
			if (uploadFile) {
				uploads.push(uploadFile);
			}
		}

		if (uploads.length > 0) {
			const uploadTasks = uploads.map(upload => async () => {
				const result = await context.api.uploadFile(
					upload.path,
					upload.content,
					upload.hash,
					upload.size,
					upload.contentType || 'application/octet-stream',
					upload.expectedHash ?? null,
				);
				if (!result.success) {
					throw new Error(result.error || `Upload failed: ${upload.path}`);
				}
				if (result.hash && result.hash !== upload.hash) {
					throw new Error(`Hash mismatch after upload for ${upload.path}`);
				}
				context.localManifest.setEntry(upload.path, {
					hash: upload.hash,
					size: upload.size,
					modified: await context.getModifiedIso(upload.path, upload.mtime),
				});
				if (isMarkdownPath(upload.path)) {
					await context.markdownBaseCache?.putBase(upload.path, upload.hash, upload.content);
				}
				completedQueueKeys.add(upload.path);
			});
			await context.runConcurrent(uploadTasks, uploadConcurrency);
		}

		if (deletes.length > 0) {
			const deleteResult = await context.api.batchDelete(
				deletes.map((file) => file.path),
				Object.fromEntries(deletes.map((file) => [file.path, file.expectedHash])),
			);
			for (const path of deleteResult.deleted) {
				context.localManifest.removeEntry(path);
				completedQueueKeys.add(`delete:${path}`);
			}
			if (!deleteResult.success) {
				const deletedSet = new Set(deleteResult.deleted);
				const failedDeletes: Array<{ path: string; error: string; status?: number }> = deleteResult.errors
					&& deleteResult.errors.length > 0
					? deleteResult.errors
					: deletes
						.filter((file) => !deletedSet.has(file.path))
						.map((file) => ({ path: file.path, error: 'Batch delete failed' }));
				for (const failedDelete of failedDeletes) {
					if (failedDelete.status === undefined || RETRYABLE_DELETE_STATUSES.has(failedDelete.status)) {
						context.pendingPaths.add(`delete:${failedDelete.path}`);
					}
				}
				await context.localManifest.save();
				clearCompletedRevisions();
				context.updateState({
					status: 'error',
					lastError: failedDeletes.map((failure) => `${failure.path}: ${failure.error}`).join('; '),
					pendingChanges: context.pendingPaths.size,
				});
				return;
			}
		}

		await context.localManifest.save();
		clearCompletedRevisions();
		context.inFlightPaths.clear();

		const didWork = uploads.length > 0 || deletes.length > 0;
		context.updateState({
			status: 'idle',
			...(didWork ? { lastSync: new Date().toISOString(), lastError: null } : {}),
			pendingChanges: context.pendingPaths.size,
		});
	} catch (error) {
		if (isAbortError(error)) {
			logger.info('Queue processing aborted');
		} else {
			if (isRetryableSyncError(error)) {
				for (const path of paths) {
					context.pendingPaths.add(path);
				}
			}
			context.inFlightPaths.clear();
			const errMsg = errorMessage(error);
			context.updateState({
				status: 'error',
				lastError: errMsg,
				pendingChanges: context.pendingPaths.size,
			});
		}
	} finally {
		context.inFlightPaths.clear();
		if (!context.isDestroyed() && context.pendingPaths.size > 0) {
			context.triggerDebouncedSync();
		}
	}
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

	if (context.pendingPaths.size === previousPendingCount) {
		return;
	}

	if (context.pendingPaths.size === 0) {
		context.clearDebounceTimer();
	}
	context.updateState({ pendingChanges: context.pendingPaths.size });
}
