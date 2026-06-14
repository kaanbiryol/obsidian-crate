import type { TAbstractFile, Vault } from 'obsidian';
import { TFolder } from 'obsidian';
import { createLogger, errorMessage } from '../plugin/logger';
import { isMarkdownPath } from './markdown-base-cache';
import { isAbortError } from './abort';
import type { PreparedUpload, SyncResult, SyncState } from '../plugin/types';

const logger = createLogger('SyncQueue');

interface QueueApi {
	isConfigured(): boolean;
	uploadFile(
		path: string,
		content: ArrayBuffer,
		hash: string,
		size: number,
		contentType: string,
	): Promise<{ success: boolean; path: string; hash?: string; error?: string }>;
	deleteFile(path: string): Promise<{ success: boolean; path: string }>;
	batchDelete(paths: string[]): Promise<{
		success: boolean;
		deleted: string[];
		errors?: Array<{ path: string; error: string }>;
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
	clearDebounceTimer(): void;
	updateState(updates: Partial<SyncState>): void;
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
		context.pendingPaths.add(`delete:${path}`);
		context.triggerDebouncedSync();
		return;
	}

	context.pendingPaths.add(path);
	context.triggerDebouncedSync();
}

export function onFileChange(context: QueueEventContext, file: TAbstractFile): void {
	if (!(file instanceof TFolder) && !context.shouldIgnore(file.path)) {
		context.pendingPaths.add(file.path);
		context.triggerDebouncedSync();
	}
}

export function onFileDelete(context: QueueEventContext, file: TAbstractFile): void {
	if (!context.shouldIgnore(file.path)) {
		context.pendingPaths.add(`delete:${file.path}`);
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
		context.pendingPaths.add(`delete:${oldPath}`);
	}
	if (!newIgnored) {
		context.pendingPaths.add(file.path);
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
	for (const path of paths) {
		context.pendingPaths.delete(path);
		context.inFlightPaths.add(path);
	}

	logger.info(`Processing ${paths.length} pending changes`);
	context.updateState({ status: 'syncing', pendingChanges: context.pendingPaths.size });

	try {
		const uploads: PreparedUpload[] = [];
		const deletes: string[] = [];

		for (const path of paths) {
			if (path.startsWith('delete:')) {
				deletes.push(path.substring(7));
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
				);
				if (!result.success) {
					throw new Error(result.error || `Upload failed: ${upload.path}`);
				}
				if (result.hash && result.hash !== upload.hash) {
					logger.warn(`Hash mismatch after upload for ${upload.path}`);
					return;
				}
				context.localManifest.setEntry(upload.path, {
					hash: upload.hash,
					size: upload.size,
					modified: await context.getModifiedIso(upload.path, upload.mtime),
				});
				if (isMarkdownPath(upload.path)) {
					await context.markdownBaseCache?.putBase(upload.path, upload.hash, upload.content);
				}
			});
			await context.runConcurrent(uploadTasks, uploadConcurrency);
		}

		if (deletes.length > 0) {
			const deleteResult = await context.api.batchDelete(deletes);
			for (const path of deleteResult.deleted) {
				context.localManifest.removeEntry(path);
			}
			if (!deleteResult.success) {
				const deletedSet = new Set(deleteResult.deleted);
				const failedDeletes = deleteResult.errors
					&& deleteResult.errors.length > 0
					? deleteResult.errors
					: deletes
						.filter((path) => !deletedSet.has(path))
						.map((path) => ({ path, error: 'Batch delete failed' }));
				for (const failedDelete of failedDeletes) {
					context.pendingPaths.add(`delete:${failedDelete.path}`);
				}
				await context.localManifest.save();
				context.updateState({
					status: 'error',
					lastError: failedDeletes.map((failure) => `${failure.path}: ${failure.error}`).join('; '),
					pendingChanges: context.pendingPaths.size,
				});
				return;
			}
		}

		await context.localManifest.save();
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
			for (const path of paths) {
				context.pendingPaths.add(path);
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
): void {
	if (!result.success || context.pendingPaths.size === 0) {
		return;
	}

	const previousPendingCount = context.pendingPaths.size;

	for (const path of result.uploadedPaths) {
		context.pendingPaths.delete(path);
	}
	for (const path of result.downloadedPaths) {
		context.pendingPaths.delete(path);
	}
	for (const path of result.mergedPaths ?? []) {
		context.pendingPaths.delete(path);
	}
	for (const path of result.deletedPaths) {
		context.pendingPaths.delete(`delete:${path}`);
	}

	if (context.pendingPaths.size === previousPendingCount) {
		return;
	}

	if (context.pendingPaths.size === 0) {
		context.clearDebounceTimer();
	}
	context.updateState({ pendingChanges: context.pendingPaths.size });
}
