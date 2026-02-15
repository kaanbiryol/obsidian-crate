import type { TFile, Vault } from 'obsidian';
import { computeHash } from './hasher';
import { createConflictCopy } from './conflict';
import { detectConflicts } from './conflict';
import { getAllVaultFiles, isHiddenPath } from './file-discovery';
import { createEmptySyncResult, finalizeSyncResult } from './sync-result';
import { createLogger } from '../logger';
import type { ChangelogEntry, CrateSettings, FileDiff, FileEntry, PreparedUpload, SyncResult } from '../types';
import { MAX_FILE_SIZE_BYTES } from '../types';

const logger = createLogger('SyncPlanner');

export interface PlannerManifest {
	getEntry(path: string): FileEntry | undefined;
	getAllPaths(): string[];
	getManifest(): { version: number; files: Record<string, FileEntry> };
	setEntry(path: string, entry: FileEntry): void;
	removeEntry(path: string): void;
	save(): Promise<void>;
}

export interface PlannerApi {
	getChanges(since: number): Promise<{ changes: ChangelogEntry[]; lastSeq: number; hasMore: boolean; cursorExpired?: boolean }>;
	downloadFile(path: string): Promise<{ content: ArrayBuffer; contentType: string; size: number }>;
	deleteFile(path: string): Promise<{ success: boolean; path: string }>;
}

export interface LocalDiffPlannerContext {
	vault: Vault;
	localManifest: PlannerManifest;
	shouldIgnore(path: string): boolean;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
}

export interface IncrementalSyncPlannerContext {
	settings: CrateSettings;
	vault: Vault;
	api: PlannerApi;
	localManifest: PlannerManifest;
	shouldIgnore(path: string): boolean;
	getLocalChanges(): Promise<{ path: string; hash: string }[]>;
	getLocalDeletes(): Promise<string[]>;
	parallelDownloadAndSaveFiles(paths: string[], result: SyncResult): Promise<void>;
	processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult,
	): Promise<void>;
	prepareUploadFromPath(path: string): Promise<PreparedUpload | null>;
	uploadPreparedFiles(
		prepared: PreparedUpload[],
		result: SyncResult,
		options: { concurrency: number; retry: boolean },
	): Promise<void>;
}

export interface FullSyncPlannerContext {
	vault: Vault;
	localManifest: PlannerManifest;
	shouldIgnore(path: string): boolean;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
	getLocalDeletes(): Promise<string[]>;
}

export interface FullSyncPlan {
	localFiles: Record<string, FileEntry>;
	diffs: FileDiff[];
	uploadDiffs: FileDiff[];
	downloadDiffs: FileDiff[];
	remainingDiffs: FileDiff[];
	errors: string[];
}

export async function getLocalDeletes(
	context: LocalDiffPlannerContext,
	prepareConcurrency: number,
): Promise<string[]> {
	const knownPaths = context.localManifest
		.getAllPaths()
		.filter(path => !context.shouldIgnore(path));

	const tasks = knownPaths.map(path => async () => {
		const exists = await context.vault.adapter.exists(path);
		return exists ? null : path;
	});

	const results = await context.runConcurrent(tasks, prepareConcurrency);
	return results.filter((path): path is string => path !== null);
}

export async function getLocalChanges(
	context: LocalDiffPlannerContext,
	prepareConcurrency: number,
): Promise<{ path: string; hash: string }[]> {
	const changes: { path: string; hash: string }[] = [];
	const allFiles = await getAllVaultFiles(context.vault, context.shouldIgnore.bind(context));

	const candidates = allFiles.filter(file => {
		if (file.size > MAX_FILE_SIZE_BYTES) return false;
		const existing = context.localManifest.getEntry(file.path);
		if (!existing) return true;
		if (existing.size !== file.size) return true;
		const manifestMtime = new Date(existing.modified).getTime();
		return Number.isNaN(manifestMtime) || manifestMtime !== file.mtime;
	});

	const tasks = candidates.map(file => async () => {
		const content = await context.vault.adapter.readBinary(file.path);
		const hash = await computeHash(content);
		const existing = context.localManifest.getEntry(file.path);
		if (!existing || existing.hash !== hash) {
			return { path: file.path, hash };
		}
		return null;
	});

	const results = await context.runConcurrent(tasks, prepareConcurrency);
	for (const result of results) {
		if (result) changes.push(result);
	}

	return changes;
}

export async function runIncrementalSync(
	context: IncrementalSyncPlannerContext,
	options: {
		uploadConcurrency: number;
		progressCallback?: (current: number, total: number) => void;
	},
): Promise<SyncResult | null> {
	if (context.settings.lastSeq <= 0) return null;

	try {
		const allChanges: ChangelogEntry[] = [];
		let since = context.settings.lastSeq;
		let latestSeq = since;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const response = await context.api.getChanges(since);

			if (response.cursorExpired) {
				logger.warn('Changelog cursor expired - pruned entries detected, falling back to full sync');
				return null;
			}

			allChanges.push(...response.changes);
			latestSeq = response.lastSeq;

			if (!response.hasMore) break;
			if (response.changes.length === 0) break;
			since = response.changes[response.changes.length - 1]!.seq;
		}

		logger.info(`Incremental sync: ${allChanges.length} remote changes since seq ${context.settings.lastSeq}`);

		const localChanges = await context.getLocalChanges();
		const localDeletes = await context.getLocalDeletes();
		logger.info(`Incremental sync: ${localChanges.length} local changes detected`);
		logger.info(`Incremental sync: ${localDeletes.length} local deletes detected`);

		if (allChanges.length === 0 && localChanges.length === 0 && localDeletes.length === 0) {
			context.settings.lastSeq = latestSeq;
			return createEmptySyncResult();
		}

		const changesByPath = new Map<string, ChangelogEntry>();
		for (const entry of allChanges) {
			changesByPath.set(entry.path, entry);
		}

		const result: SyncResult = createEmptySyncResult();
		const localChangedPaths = new Set(localChanges.map(f => f.path));
		const localDeletedPaths = new Set(localDeletes);
		const resurrectPaths = new Set<string>();

		const downloadPaths: string[] = [];
		const conflicts: FileDiff[] = [];

		for (const [path, entry] of changesByPath) {
			if (context.shouldIgnore(path)) continue;

			try {
				if (entry.action === 'delete') {
					if (localChangedPaths.has(path)) {
						resurrectPaths.add(path);
						result.conflicts.push(path);
						continue;
					}

					const file = context.vault.getAbstractFileByPath(path);
					let deletedLocally = false;
					if (file) {
						await context.vault.delete(file);
						deletedLocally = true;
					} else if (await context.vault.adapter.exists(path)) {
						await context.vault.adapter.remove(path);
						deletedLocally = true;
					}
					context.localManifest.removeEntry(path);
					if (deletedLocally) {
						result.deleted++;
					}
				} else if (entry.action === 'put') {
					if (entry.size > MAX_FILE_SIZE_BYTES) {
						result.errors.push(`${path}: Skipped remote file larger than 25MB`);
						continue;
					}

					if (localDeletedPaths.has(path)) {
						const response = await context.api.downloadFile(path);
						const conflictPath = await createConflictCopy(context.vault, path, response.content);
						result.conflicts.push(conflictPath);
						continue;
					}

					const localFile = context.vault.getAbstractFileByPath(path);

					if (!localFile && !(isHiddenPath(path) && await context.vault.adapter.exists(path))) {
						downloadPaths.push(path);
					} else {
						const stat = localFile && 'stat' in localFile
							? (localFile as TFile).stat
							: await context.vault.adapter.stat(path);
						if ((stat?.size ?? 0) > MAX_FILE_SIZE_BYTES) {
							result.errors.push(`${path}: Skipped local file larger than 25MB`);
							continue;
						}

						const content = await context.vault.adapter.readBinary(path);
						const localHash = await computeHash(content);

						if (localHash === entry.hash) {
							context.localManifest.setEntry(path, {
								hash: localHash,
								size: stat?.size ?? 0,
								modified: new Date(stat?.mtime ?? Date.now()).toISOString(),
							});
						} else if (localChangedPaths.has(path)) {
							conflicts.push({
								path,
								action: 'conflict',
								localHash,
								remoteHash: entry.hash,
							});
						} else {
							downloadPaths.push(path);
						}
					}
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				result.errors.push(`${path}: ${errorMessage}`);
			}
		}

		const localOnlyChanges = localChanges.filter(
			f => (!changesByPath.has(f.path) || resurrectPaths.has(f.path)) && !context.shouldIgnore(f.path),
		);
		const localOnlyDeletes = localDeletes.filter(
			path => !changesByPath.has(path) && !context.shouldIgnore(path),
		);
		const total = changesByPath.size + localOnlyChanges.length + localOnlyDeletes.length;
		let current = 0;

		if (downloadPaths.length > 0) {
			await context.parallelDownloadAndSaveFiles(downloadPaths, result);
		}
		current += changesByPath.size;
		options.progressCallback?.(current, total);

		for (const diff of conflicts) {
			try {
				const localFiles: Record<string, FileEntry> = {};
				await context.processDiff(diff, localFiles, result);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				result.errors.push(`${diff.path}: ${errorMessage}`);
			}
		}

		const localOnlyUploads: PreparedUpload[] = [];
		for (const file of localOnlyChanges) {
			try {
				const uploadFile = await context.prepareUploadFromPath(file.path);
				if (uploadFile) {
					localOnlyUploads.push(uploadFile);
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				result.errors.push(`${file.path}: ${errorMessage}`);
			}
			current++;
			options.progressCallback?.(current, total);
		}
		await context.uploadPreparedFiles(localOnlyUploads, result, {
			concurrency: options.uploadConcurrency,
			retry: false,
		});

		for (const path of localOnlyDeletes) {
			try {
				await context.api.deleteFile(path);
				context.localManifest.removeEntry(path);
				result.deleted++;
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				result.errors.push(`${path}: ${errorMessage}`);
			}
			current++;
			options.progressCallback?.(current, total);
		}

		await context.localManifest.save();
		if (finalizeSyncResult(result)) {
			context.settings.lastSeq = latestSeq;
		}

		logger.info(`Incremental sync completed: ${result.uploaded} up, ${result.downloaded} down, ${result.deleted} del, ${result.conflicts.length} conflicts`);
		return result;
	} catch (error) {
		logger.warn('Incremental sync failed, falling back to full sync:', error instanceof Error ? error.message : 'Unknown error');
		return null;
	}
}

export async function createFullSyncPlan(
	context: FullSyncPlannerContext,
	remoteFiles: Record<string, FileEntry>,
	prepareConcurrency: number,
): Promise<FullSyncPlan> {
	const localFiles: Record<string, FileEntry> = {};
	const files = await getAllVaultFiles(context.vault, context.shouldIgnore.bind(context));
	const largeLocalPaths = new Set(
		files.filter(file => file.size > MAX_FILE_SIZE_BYTES).map(file => file.path),
	);

	const eligible = files.filter(file => file.size <= MAX_FILE_SIZE_BYTES);

	for (const file of eligible) {
		const existing = context.localManifest.getEntry(file.path);
		if (existing && existing.size === file.size) {
			const manifestMtime = new Date(existing.modified).getTime();
			if (!Number.isNaN(manifestMtime) && manifestMtime === file.mtime) {
				localFiles[file.path] = {
					hash: existing.hash,
					size: file.size,
					modified: new Date(file.mtime).toISOString(),
				};
			}
		}
	}

	const hashTasks = eligible
		.filter(file => !(file.path in localFiles))
		.map(file => async () => {
			const content = await context.vault.adapter.readBinary(file.path);
			const hash = await computeHash(content);
			return { path: file.path, hash, size: file.size, mtime: file.mtime };
		});
	const hashed = await context.runConcurrent(hashTasks, prepareConcurrency);
	for (const entry of hashed) {
		localFiles[entry.path] = {
			hash: entry.hash,
			size: entry.size,
			modified: new Date(entry.mtime).toISOString(),
		};
	}

	const manifestEntries = context.localManifest.getManifest().files;
	const diffMap = new Map<string, FileDiff>();
	for (const diff of detectConflicts(
		localFiles,
		remoteFiles,
		manifestEntries,
	)) {
		diffMap.set(diff.path, diff);
	}

	const localDeletes = await context.getLocalDeletes();
	for (const path of localDeletes) {
		const remoteEntry = remoteFiles[path];
		if (!remoteEntry) {
			context.localManifest.removeEntry(path);
			continue;
		}
		const manifestEntry = manifestEntries[path];
		if (manifestEntry && remoteEntry.hash === manifestEntry.hash) {
			diffMap.set(path, { path, action: 'delete', remoteHash: remoteEntry.hash });
		}
	}

	const errors: string[] = [];
	for (const [path, diff] of [...diffMap.entries()]) {
		const remoteEntry = remoteFiles[path];
		if (context.shouldIgnore(path)) {
			diffMap.delete(path);
			continue;
		}
		if (largeLocalPaths.has(path)) {
			errors.push(`${path}: Skipped local file larger than 25MB`);
			diffMap.delete(path);
			continue;
		}
		if (remoteEntry && remoteEntry.size > MAX_FILE_SIZE_BYTES) {
			errors.push(`${path}: Skipped remote file larger than 25MB`);
			diffMap.delete(path);
			continue;
		}
		if (diff.action === 'download' && !remoteEntry) {
			diffMap.delete(path);
		}
	}

	const diffs = [...diffMap.values()];
	const uploadDiffs = diffs.filter(d => d.action === 'upload');
	const downloadDiffs = diffs.filter(d => d.action === 'download');
	const remainingDiffs = diffs.filter(d => d.action === 'conflict' || d.action === 'delete');

	return {
		localFiles,
		diffs,
		uploadDiffs,
		downloadDiffs,
		remainingDiffs,
		errors,
	};
}
