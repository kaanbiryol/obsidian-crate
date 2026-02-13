/**
 * Core sync engine - orchestrates synchronization between local vault and remote storage
 */

import type { Plugin, TFile, TAbstractFile, Vault } from 'obsidian';
import { TFolder } from 'obsidian';
import { SyncApiClient } from './api';
import { LocalManifest } from './manifest';
import { computeHash } from './hasher';
import { detectConflicts, createConflictCopy, isConflictFile } from './conflict';
import { getAllVaultFiles, isHiddenPath, getExtensionFromPath, tfileToVaultFile } from './file-discovery';
import type { VaultFile } from './file-discovery';
import { createLogger } from '../logger';
import type {
	SyncState,
	SyncResult,
	FileDiff,
	PreparedUpload,
	FileEntry,
	CrateSettings,
	ChangelogEntry,
} from '../types';
import { DEBOUNCE_DELAY_MS, MAX_FILE_SIZE_BYTES } from '../types';

const logger = createLogger('SyncEngine');
const UPLOAD_CONCURRENCY = 5;
const DOWNLOAD_CONCURRENCY = 5;
const FORCE_SYNC_CONCURRENCY = 2;
const PREPARE_CONCURRENCY = 5;
const INITIAL_SYNC_PIPELINE_CHUNK_FILES = 120;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

export class SyncEngine {
	private plugin: Plugin;
	private vault: Vault;
	private api: SyncApiClient;
	private localManifest: LocalManifest;
	private settings: CrateSettings;
	private state: SyncState;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingPaths: Set<string> = new Set();
	private syncInterval: ReturnType<typeof setInterval> | null = null;
	private onStateChange: ((state: SyncState) => void) | null = null;
	private patternCache = new Map<string, RegExp>();
	private ignoredDirPrefixes: string[] = [];

	constructor(
		plugin: Plugin,
		api: SyncApiClient,
		settings: CrateSettings
	) {
		this.plugin = plugin;
		this.vault = plugin.app.vault;
		this.api = api;
		this.settings = settings;
		this.localManifest = new LocalManifest(plugin.app, plugin.manifest);
		this.ignoredDirPrefixes = settings.ignorePatterns.filter(p => p.endsWith('/'));
		this.state = {
			status: 'idle',
			lastSync: settings.lastSync,
			lastError: null,
			pendingChanges: 0,
		};
	}

	/**
	 * Initialize the sync engine
	 */
	async initialize(): Promise<void> {
		await this.localManifest.load();
		logger.info('Engine initialized');

		// Set up periodic sync if enabled
		if (this.settings.syncInterval > 0) {
			this.startPeriodicSync();
		}
	}

	/**
	 * Set state change callback
	 */
	setStateChangeCallback(callback: (state: SyncState) => void): void {
		this.onStateChange = callback;
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: CrateSettings): void {
		this.patternCache.clear();
		this.settings = settings;
		this.ignoredDirPrefixes = settings.ignorePatterns.filter(p => p.endsWith('/'));

		// Restart periodic sync with new interval
		this.stopPeriodicSync();
		if (settings.syncInterval > 0) {
			this.startPeriodicSync();
		}
	}

	/**
	 * Get current sync state
	 */
	getState(): SyncState {
		return { ...this.state };
	}

	/**
	 * Start periodic sync
	 */
	private startPeriodicSync(): void {
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
		}
		this.syncInterval = setInterval(
			() => this.periodicCheck(),
			this.settings.syncInterval * 1000
		);
	}

	/**
	 * Lightweight periodic check — only triggers full sync if remote has changes
	 */
	private async periodicCheck(): Promise<void> {
		if (this.state.status === 'syncing') return;
		if (!this.api.isConfigured()) return;

		try {
			const { hasChanges } = await this.api.checkForChanges(this.settings.lastSeq);

			if (!hasChanges && this.pendingPaths.size === 0) {
				logger.debug('Periodic check: no changes');
				return;
			}

			logger.info('Periodic check: changes detected, running sync');
			await this.sync();
		} catch (error) {
			logger.warn('Periodic check failed:', error instanceof Error ? error.message : 'Unknown error');
		}
	}

	/**
	 * Stop periodic sync
	 */
	private stopPeriodicSync(): void {
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
			this.syncInterval = null;
		}
	}

	/**
	 * Update and notify state change
	 */
	private updateState(updates: Partial<SyncState>): void {
		this.state = { ...this.state, ...updates };
		this.onStateChange?.(this.state);
	}

	/**
	 * Check if path should be ignored
	 */
	private shouldIgnore(path: string): boolean {
		// Always ignore conflict files to prevent loops
		if (isConflictFile(path)) {
			return true;
		}

		// Ignore legacy merge cache artifacts if present.
		if (path.startsWith('.obsidian/plugins/obsidian-crate/bases/')) {
			return true;
		}

		// Fast-path: check pre-computed directory prefixes with startsWith
		for (const prefix of this.ignoredDirPrefixes) {
			if (path.startsWith(prefix) || path === prefix.slice(0, -1)) {
				return true;
			}
		}

		for (const pattern of this.settings.ignorePatterns) {
			// Skip directory patterns already handled above
			if (pattern.endsWith('/')) continue;
			if (this.matchPattern(path, pattern)) {
					return true;
			}
		}
		return false;
	}

	/**
	 * Simple glob pattern matching
	 * Trailing-slash patterns (e.g. `.trash/`) match everything under that prefix.
	 */
	private matchPattern(path: string, pattern: string): boolean {
		// Trailing-slash pattern: match the prefix and anything beneath it
		if (pattern.endsWith('/')) {
			return path.startsWith(pattern) || path === pattern.slice(0, -1);
		}

		let regex = this.patternCache.get(pattern);
		if (!regex) {
			const regexPattern = pattern
				.replace(/\./g, '\\.')
				.replace(/\*/g, '.*')
				.replace(/\?/g, '.');
			regex = new RegExp(`^${regexPattern}$`);
			this.patternCache.set(pattern, regex);
		}
		return regex.test(path);
	}

	/**
	 * Handle file change (create, modify)
	 */
	onFileChange(file: TAbstractFile): void {
		if (!(file instanceof TFolder)) {
			if (!this.shouldIgnore(file.path)) {
				this.pendingPaths.add(file.path);
				this.debouncedSync();
			}
		}
	}

	/**
	 * Handle file deletion
	 */
	onFileDelete(file: TAbstractFile): void {
		if (!this.shouldIgnore(file.path)) {
			this.pendingPaths.add(`delete:${file.path}`);
			this.debouncedSync();
		}
	}

	/**
	 * Handle file rename
	 */
	onFileRename(file: TAbstractFile, oldPath: string): void {
		if (!this.shouldIgnore(oldPath) && !this.shouldIgnore(file.path)) {
			this.pendingPaths.add(`delete:${oldPath}`);
			this.pendingPaths.add(file.path);
			this.debouncedSync();
		}
	}

	/**
	 * Debounced sync trigger
	 */
	private debouncedSync(): void {
		this.updateState({ pendingChanges: this.pendingPaths.size });

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			this.processPendingChanges();
		}, DEBOUNCE_DELAY_MS);
	}

	/**
	 * Process pending file changes
	 */
	private async processPendingChanges(): Promise<void> {
		if (this.pendingPaths.size === 0) return;
		if (this.state.status === 'syncing') return;
		if (!this.api.isConfigured()) return;

		logger.info(`Processing ${this.pendingPaths.size} pending changes`);
		const paths = Array.from(this.pendingPaths);

		this.updateState({ status: 'syncing', pendingChanges: 0 });

		try {
			const uploads: PreparedUpload[] = [];
			const deletes: string[] = [];

			for (const path of paths) {
				if (path.startsWith('delete:')) {
					deletes.push(path.substring(7));
				} else {
					const file = this.vault.getAbstractFileByPath(path);
					if (file && 'extension' in file) {
						const uploadFile = await this.prepareUpload(file as TFile);
						if (uploadFile) {
							uploads.push(uploadFile);
						}
					} else if (isHiddenPath(path)) {
						// Hidden file not in Obsidian index — use adapter
						const stat = await this.vault.adapter.stat(path);
						if (stat && stat.type === 'file') {
							const uploadFile = await this.prepareUploadFromVaultFile({
								path,
								size: stat.size,
								mtime: stat.mtime,
								extension: getExtensionFromPath(path),
							});
							if (uploadFile) {
								uploads.push(uploadFile);
							}
						}
					}
				}
			}

				// Upload changed files concurrently
				if (uploads.length > 0) {
					const uploadTasks = uploads.map(upload => async () => {
						const result = await this.api.uploadFile(
							upload.path,
							upload.content,
							upload.hash,
							upload.size,
							upload.contentType || 'application/octet-stream',
						);
						if (result.success) {
							if (result.hash && result.hash !== upload.hash) {
								logger.warn(`Hash mismatch after upload for ${upload.path}`);
								return;
							}
							this.localManifest.setEntry(upload.path, {
								hash: upload.hash,
								size: upload.size,
								modified: await this.getModifiedIso(upload.path, upload.mtime),
							});
						}
					});
					await this.runConcurrent(uploadTasks, UPLOAD_CONCURRENCY);
				}

				// Process deletes
				for (const path of deletes) {
					await this.api.deleteFile(path);
					this.localManifest.removeEntry(path);
				}

			await this.localManifest.save();

			// Fix 1: Clear pending paths only after successful sync
			this.pendingPaths.clear();

			this.updateState({
				status: 'idle',
				lastSync: new Date().toISOString(),
				lastError: null,
			});
		} catch (error) {
			// Fix 1: Re-add paths back on failure so they're retried
			for (const p of paths) {
				this.pendingPaths.add(p);
			}
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.updateState({
				status: 'error',
				lastError: errorMessage,
			});
		}
	}

	/**
	 * Prepare a TFile for upload (delegates to VaultFile variant)
	 */
	private async prepareUpload(file: TFile): Promise<PreparedUpload | null> {
		return this.prepareUploadFromVaultFile(tfileToVaultFile(file));
	}

	/**
	 * Prepare a VaultFile for upload — works for both indexed and hidden files.
	 * Reads content via the low-level adapter so hidden files are supported.
	 * Returns ArrayBuffer content directly (no base64 encoding).
	 */
	private async prepareUploadFromVaultFile(file: VaultFile): Promise<PreparedUpload | null> {
		// Check file size
		if (file.size > MAX_FILE_SIZE_BYTES) {
			logger.warn('Skipping large file:', file.path);
			return null;
		}

		const content = await this.vault.adapter.readBinary(file.path);
		const hash = await computeHash(content);

		// Check if file actually changed
		if (this.localManifest.hashMatches(file.path, hash)) {
			logger.debug('Skipping unchanged file:', file.path);
			return null;
		}

		return {
			path: file.path,
			content,
			hash,
			size: file.size,
			mtime: file.mtime,
			contentType: this.getContentType(file.extension),
		};
	}

	/**
	 * Run tasks with limited concurrency
	 */
	private async runConcurrent<T>(
		tasks: (() => Promise<T>)[],
		concurrency: number
	): Promise<T[]> {
		const results: T[] = [];
		let index = 0;
		async function next(): Promise<void> {
			while (index < tasks.length) {
				const i = index++;
				results[i] = await tasks[i]!();
			}
		}
		await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => next()));
		return results;
	}

	/**
	 * Retry an async operation with exponential backoff
	 */
	private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				return await fn();
			} catch (error) {
				if (attempt === MAX_RETRIES) throw error;
				const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
				logger.warn(`Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms`);
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}
		throw new Error('Unreachable');
	}

	/**
	 * Get content type for file extension
	 */
	private getContentType(extension: string): string {
		const types: Record<string, string> = {
			'md': 'text/markdown',
			'txt': 'text/plain',
			'json': 'application/json',
			'css': 'text/css',
			'js': 'application/javascript',
			'ts': 'application/typescript',
			'html': 'text/html',
			'xml': 'application/xml',
			'yaml': 'text/yaml',
			'yml': 'text/yaml',
			'png': 'image/png',
			'jpg': 'image/jpeg',
			'jpeg': 'image/jpeg',
			'gif': 'image/gif',
			'svg': 'image/svg+xml',
			'pdf': 'application/pdf',
		};
		return types[extension.toLowerCase()] || 'application/octet-stream';
	}

	private async getModifiedIso(path: string, fallbackMtime?: number): Promise<string> {
		const stat = await this.vault.adapter.stat(path);
		return new Date(stat?.mtime ?? fallbackMtime ?? Date.now()).toISOString();
	}

	private async getLocalDeletes(): Promise<string[]> {
		const knownPaths = this.localManifest
			.getAllPaths()
			.filter(path => !this.shouldIgnore(path));

		const tasks = knownPaths.map(path => async () => {
			const exists = await this.vault.adapter.exists(path);
			return exists ? null : path;
		});

		const results = await this.runConcurrent(tasks, PREPARE_CONCURRENCY);
		return results.filter((path): path is string => path !== null);
	}

	/**
	 * Incremental sync using changelog.
	 * Returns SyncResult on success, or null to fall back to full sync.
	 */
	private async incrementalSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult | null> {
		if (this.settings.lastSeq <= 0) return null;

		try {
			// Fetch all changes since our cursor, paginating if needed
			const allChanges: ChangelogEntry[] = [];
			let since = this.settings.lastSeq;
			let latestSeq = since;

			// eslint-disable-next-line no-constant-condition
			while (true) {
				const response = await this.api.getChanges(since);
				allChanges.push(...response.changes);
				latestSeq = response.lastSeq;

				if (!response.hasMore) break;
				if (response.changes.length === 0) break;
				// Move cursor to last fetched seq for next page
				since = response.changes[response.changes.length - 1]!.seq;
			}

			logger.info(`Incremental sync: ${allChanges.length} remote changes since seq ${this.settings.lastSeq}`);

			// Get local changes/deletes once, reuse for early-exit check and main logic
			const localChanges = await this.getLocalChanges();
			const localDeletes = await this.getLocalDeletes();
			logger.info(`Incremental sync: ${localChanges.length} local changes detected`);
			logger.info(`Incremental sync: ${localDeletes.length} local deletes detected`);

			if (allChanges.length === 0 && localChanges.length === 0 && localDeletes.length === 0) {
				this.settings.lastSeq = latestSeq;
				return {
					success: true,
					uploaded: 0,
					downloaded: 0,
					deleted: 0,
					conflicts: [],
					errors: [],
				};
			}

			// Deduplicate: last entry per path wins
			const changesByPath = new Map<string, ChangelogEntry>();
			for (const entry of allChanges) {
				changesByPath.set(entry.path, entry);
			}

			const result: SyncResult = {
				success: true,
				uploaded: 0,
				downloaded: 0,
				deleted: 0,
				conflicts: [],
				errors: [],
			};
			const localChangedPaths = new Set(localChanges.map(f => f.path));
			const localDeletedPaths = new Set(localDeletes);
			const resurrectPaths = new Set<string>();

			// Categorize remote changes
			const downloadPaths: string[] = [];
			const conflicts: FileDiff[] = [];

			for (const [path, entry] of changesByPath) {
				if (this.shouldIgnore(path)) continue;

				try {
					if (entry.action === 'delete') {
						// Keep local edits and resurrect remotely later rather than losing data.
						if (localChangedPaths.has(path)) {
							resurrectPaths.add(path);
							result.conflicts.push(path);
							continue;
						}

						const file = this.vault.getAbstractFileByPath(path);
						let deletedLocally = false;
						if (file) {
							await this.vault.delete(file);
							deletedLocally = true;
						} else if (await this.vault.adapter.exists(path)) {
							await this.vault.adapter.remove(path);
							deletedLocally = true;
						}
							this.localManifest.removeEntry(path);
						if (deletedLocally) {
							result.deleted++;
						}
					} else if (entry.action === 'put') {
						if (entry.size > MAX_FILE_SIZE_BYTES) {
							result.errors.push(`${path}: Skipped remote file larger than 25MB`);
							continue;
						}

						// Preserve local delete intent by writing incoming remote content as a conflict copy.
						if (localDeletedPaths.has(path)) {
							const response = await this.api.downloadFile(path);
							const conflictPath = await createConflictCopy(this.vault, path, response.content);
							result.conflicts.push(conflictPath);
							continue;
						}

						const localFile = this.vault.getAbstractFileByPath(path);

						if (!localFile && !(isHiddenPath(path) && await this.vault.adapter.exists(path))) {
							downloadPaths.push(path);
						} else {
							const stat = localFile && 'stat' in localFile
								? (localFile as TFile).stat
								: await this.vault.adapter.stat(path);
							if ((stat?.size ?? 0) > MAX_FILE_SIZE_BYTES) {
								result.errors.push(`${path}: Skipped local file larger than 25MB`);
								continue;
							}

							const content = await this.vault.adapter.readBinary(path);
							const localHash = await computeHash(content);

							if (localHash === entry.hash) {
									this.localManifest.setEntry(path, {
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

			// Count local changes/deletes that won't be skipped
			const localOnlyChanges = localChanges.filter(
				f => (!changesByPath.has(f.path) || resurrectPaths.has(f.path)) && !this.shouldIgnore(f.path),
			);
			const localOnlyDeletes = localDeletes.filter(
				path => !changesByPath.has(path) && !this.shouldIgnore(path),
			);
			const total = changesByPath.size + localOnlyChanges.length + localOnlyDeletes.length;
			let current = 0;

			// Download remote files in parallel
			if (downloadPaths.length > 0) {
				await this.parallelDownloadAndSaveFiles(downloadPaths, result);
			}
			current += changesByPath.size;
			progressCallback?.(current, total);

			// Process conflicts sequentially
			for (const diff of conflicts) {
				try {
					const localFiles: Record<string, FileEntry> = {};
					await this.processDiff(diff, localFiles, result);
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					result.errors.push(`${diff.path}: ${errorMessage}`);
				}
			}

			// Upload local-only changes (modified locally but not in remote changeset)
			const localOnlyUploads: PreparedUpload[] = [];
			for (const file of localOnlyChanges) {
				try {
					const tfile = this.vault.getAbstractFileByPath(file.path);
					let uploadFile: PreparedUpload | null = null;
					if (tfile && 'extension' in tfile) {
						uploadFile = await this.prepareUpload(tfile as TFile);
					} else if (isHiddenPath(file.path)) {
						const stat = await this.vault.adapter.stat(file.path);
						if (stat && stat.type === 'file') {
							uploadFile = await this.prepareUploadFromVaultFile({
								path: file.path,
								size: stat.size,
								mtime: stat.mtime,
								extension: getExtensionFromPath(file.path),
							});
						}
					}
					if (uploadFile) {
						localOnlyUploads.push(uploadFile);
					}
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					result.errors.push(`${file.path}: ${errorMessage}`);
				}
				current++;
				progressCallback?.(current, total);
			}
			await this.uploadPreparedFiles(localOnlyUploads, result, {
				concurrency: UPLOAD_CONCURRENCY,
				retry: false,
			});

			// Propagate local deletions missed while offline/unloaded.
			for (const path of localOnlyDeletes) {
				try {
					await this.api.deleteFile(path);
					this.localManifest.removeEntry(path);
					result.deleted++;
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					result.errors.push(`${path}: ${errorMessage}`);
				}
				current++;
				progressCallback?.(current, total);
			}

			await this.localManifest.save();
			this.settings.lastSeq = latestSeq;
			result.success = result.errors.length === 0;

			logger.info(`Incremental sync completed: ${result.uploaded} up, ${result.downloaded} down, ${result.deleted} del, ${result.conflicts.length} conflicts`);
			return result;
		} catch (error) {
			logger.warn('Incremental sync failed, falling back to full sync:', error instanceof Error ? error.message : 'Unknown error');
			return null;
		}
	}

	/**
	 * Get locally modified files since last sync
	 */
	private async getLocalChanges(): Promise<{ path: string; hash: string }[]> {
		const changes: { path: string; hash: string }[] = [];
		const allFiles = await getAllVaultFiles(this.vault, this.shouldIgnore.bind(this));

		const candidates = allFiles.filter(file => {
			if (file.size > MAX_FILE_SIZE_BYTES) return false;
			const existing = this.localManifest.getEntry(file.path);
			if (!existing) return true;
			if (existing.size !== file.size) return true;
			const manifestMtime = new Date(existing.modified).getTime();
			return Number.isNaN(manifestMtime) || manifestMtime !== file.mtime;
		});

		const tasks = candidates.map(file => async () => {
			const content = await this.vault.adapter.readBinary(file.path);
			const hash = await computeHash(content);
			const existing = this.localManifest.getEntry(file.path);
			if (!existing || existing.hash !== hash) {
				return { path: file.path, hash };
			}
			return null;
		});

		const results = await this.runConcurrent(tasks, PREPARE_CONCURRENCY);
		for (const result of results) {
			if (result) changes.push(result);
		}

		return changes;
	}

	/**
	 * Download a file from remote and save it locally
	 */
	private async downloadAndSaveFile(path: string, result: SyncResult): Promise<void> {
		const response = await this.api.downloadFile(path);
		const content = response.content;
		if (content.byteLength > MAX_FILE_SIZE_BYTES) {
			result.errors.push(`${path}: Skipped remote file larger than 25MB`);
			return;
		}

		await this.saveDownloadedContent(path, content);
		result.downloaded++;
	}

	private async saveDownloadedContent(path: string, content: ArrayBuffer): Promise<void> {
		if (content.byteLength > MAX_FILE_SIZE_BYTES) {
			throw new Error('Skipped remote file larger than 25MB');
		}

		const folderPath = path.substring(0, path.lastIndexOf('/'));
		if (folderPath) {
			if (isHiddenPath(path)) {
				try { await this.vault.adapter.mkdir(folderPath); } catch { /* exists */ }
			} else {
				try { await this.vault.createFolder(folderPath); } catch { /* exists */ }
			}
		}

		if (isHiddenPath(path)) {
			await this.vault.adapter.writeBinary(path, content);
		} else {
			const existingFile = this.vault.getAbstractFileByPath(path);
			if (existingFile) {
				await this.vault.modifyBinary(existingFile as TFile, content);
			} else {
				await this.vault.createBinary(path, content);
			}
		}

		const hash = await computeHash(content);
		this.localManifest.setEntry(path, {
			hash,
			size: content.byteLength,
			modified: await this.getModifiedIso(path),
		});
	}

	/**
	 * Download files in parallel using individual binary requests
	 */
	private async parallelDownloadAndSaveFiles(paths: string[], result: SyncResult): Promise<void> {
		const tasks = paths.map(path => async () => {
			try {
				await this.downloadAndSaveFile(path, result);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Download failed';
				result.errors.push(`${path}: ${errorMessage}`);
			}
		});
		await this.runConcurrent(tasks, DOWNLOAD_CONCURRENCY);
	}

	/**
	 * Full sync - compare manifests and sync all differences
	 */
	async sync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		if (!this.api.isConfigured()) {
			return {
				success: false,
				uploaded: 0,
				downloaded: 0,
				deleted: 0,
				conflicts: [],
				errors: ['Not configured'],
			};
		}

		if (this.state.status === 'syncing') {
			return {
				success: false,
				uploaded: 0,
				downloaded: 0,
				deleted: 0,
				conflicts: [],
				errors: ['Sync already in progress'],
			};
		}

		logger.info('Sync started');
		this.updateState({ status: 'syncing' });

		// Try incremental sync first
		const incrementalResult = await this.incrementalSync(progressCallback);
		if (incrementalResult) {
			const lastSync = new Date().toISOString();
			this.updateState({ status: 'idle', lastSync, lastError: null });
			this.settings.lastSync = lastSync;
			return incrementalResult;
		}

		logger.info('Running full sync');

		const result: SyncResult = {
			success: true,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: [],
			errors: [],
		};

		try {
			// Get remote manifest
			const remoteManifest = await this.api.getManifest();

			// Build local manifest from current vault state
			const localFiles: Record<string, FileEntry> = {};
			const files = await getAllVaultFiles(this.vault, this.shouldIgnore.bind(this));
			const largeLocalPaths = new Set(
				files.filter(file => file.size > MAX_FILE_SIZE_BYTES).map(file => file.path),
			);

			const hashTasks = files
				.filter(file => file.size <= MAX_FILE_SIZE_BYTES)
				.map(file => async () => {
					const content = await this.vault.adapter.readBinary(file.path);
					const hash = await computeHash(content);
					return { path: file.path, hash, size: file.size, mtime: file.mtime };
				});
			const hashed = await this.runConcurrent(hashTasks, PREPARE_CONCURRENCY);
			for (const entry of hashed) {
				localFiles[entry.path] = {
					hash: entry.hash,
					size: entry.size,
					modified: new Date(entry.mtime).toISOString(),
				};
			}

			// Get manifest entries for 3-way conflict detection
			const manifestEntries = this.localManifest.getManifest().files;

			// Detect differences using 3-way hash comparison
			const diffMap = new Map<string, FileDiff>();
			for (const diff of detectConflicts(
				localFiles,
				remoteManifest.files,
				manifestEntries,
			)) {
				diffMap.set(diff.path, diff);
			}

			// Reconcile local deletions that happened while the plugin was offline/unloaded.
			const localDeletes = await this.getLocalDeletes();
			for (const path of localDeletes) {
				const remoteEntry = remoteManifest.files[path];
				if (!remoteEntry) {
					this.localManifest.removeEntry(path);
					continue;
				}
				// If manifest has the entry and remote hash matches manifest, local deleted since last sync → delete remote
				const manifestEntry = manifestEntries[path];
				if (manifestEntry && remoteEntry.hash === manifestEntry.hash) {
					diffMap.set(path, { path, action: 'delete', remoteHash: remoteEntry.hash });
				}
			}

			// Enforce size limits defensively to avoid accidental overwrites of unsupported files.
			for (const [path, diff] of [...diffMap.entries()]) {
				const remoteEntry = remoteManifest.files[path];
				if (largeLocalPaths.has(path)) {
					result.errors.push(`${path}: Skipped local file larger than 25MB`);
					diffMap.delete(path);
					continue;
				}
				if (remoteEntry && remoteEntry.size > MAX_FILE_SIZE_BYTES) {
					result.errors.push(`${path}: Skipped remote file larger than 25MB`);
					diffMap.delete(path);
					continue;
				}
				if (diff.action === 'download' && !remoteEntry) {
					diffMap.delete(path);
				}
			}

			const diffs = [...diffMap.values()];

			// Process differences — uploads concurrent, downloads parallel, rest sequential
			const uploadDiffs = diffs.filter(d => d.action === 'upload');
			const downloadDiffs = diffs.filter(d => d.action === 'download');
			const conflictDiffs = diffs.filter(d => d.action === 'conflict');
			const deleteDiffs = diffs.filter(d => d.action === 'delete');
			logger.info(`Full sync diffs: ${uploadDiffs.length} upload, ${downloadDiffs.length} download, ${conflictDiffs.length} conflict, ${deleteDiffs.length} delete`);

			const total = diffs.length;
			let current = 0;

			// Run upload diffs concurrently
			if (uploadDiffs.length > 0) {
				const uploadTasks = uploadDiffs.map(diff => async () => {
					try {
						await this.processDiff(diff, localFiles, result);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : 'Unknown error';
						result.errors.push(`${diff.path}: ${errorMessage}`);
					}
					current++;
					progressCallback?.(current, total);
				});
				await this.runConcurrent(uploadTasks, UPLOAD_CONCURRENCY);
			}

			// Download files in parallel
				if (downloadDiffs.length > 0) {
					await this.parallelDownloadAndSaveFiles(
						downloadDiffs.map(d => d.path),
						result,
					);
					// Update localFiles record for downloaded files
					for (const diff of downloadDiffs) {
						try {
							const content = await this.vault.adapter.readBinary(diff.path);
							const hash = await computeHash(content);
							localFiles[diff.path] = {
								hash,
								size: content.byteLength,
								modified: await this.getModifiedIso(diff.path),
							};
						} catch {
							// File may have failed to download; error already recorded
						}
					}
					current += downloadDiffs.length;
					progressCallback?.(current, total);
				}

			// Process conflict and delete diffs sequentially
			const remainingDiffs = diffs.filter(d => d.action === 'conflict' || d.action === 'delete');
			for (const diff of remainingDiffs) {
				try {
					await this.processDiff(diff, localFiles, result);
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					result.errors.push(`${diff.path}: ${errorMessage}`);
				}
				current++;
				progressCallback?.(current, total);
			}

			// Get and process tombstones
			const tombstones = await this.api.getTombstones();
			for (const tombstone of tombstones.deleted) {
				// Ignore stale tombstones for paths that currently exist remotely.
				if (remoteManifest.files[tombstone.path]) {
					continue;
				}

				const file = this.vault.getAbstractFileByPath(tombstone.path);
				if (file) {
					await this.vault.delete(file);
						this.localManifest.removeEntry(tombstone.path);
						result.deleted++;
					} else if (await this.vault.adapter.exists(tombstone.path)) {
						await this.vault.adapter.remove(tombstone.path);
						this.localManifest.removeEntry(tombstone.path);
						result.deleted++;
					}
				}

			// Update local manifest
			for (const [path, entry] of Object.entries(localFiles)) {
				this.localManifest.setEntry(path, entry);
			}
			await this.localManifest.save();

			const lastSync = new Date().toISOString();
			this.updateState({
				status: 'idle',
				lastSync,
				lastError: result.errors.length > 0 ? result.errors[0] ?? null : null,
			});

			// Save last sync time and seq cursor to settings
			this.settings.lastSync = lastSync;
			if (remoteManifest.lastSeq !== undefined && remoteManifest.lastSeq > 0) {
				this.settings.lastSeq = remoteManifest.lastSeq;
			}

			logger.info(`Full sync completed: ${result.uploaded} up, ${result.downloaded} down, ${result.conflicts.length} conflicts`);
			result.success = result.errors.length === 0;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			result.errors.push(errorMessage);
			result.success = false;
			logger.error('Full sync failed:', errorMessage);
			this.updateState({
				status: 'error',
				lastError: errorMessage,
			});
		}

		return result;
	}

	/**
	 * Process a single diff
	 */
	private async processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult
	): Promise<void> {
		const hidden = isHiddenPath(diff.path);

		switch (diff.action) {
			case 'upload': {
				const file = this.vault.getAbstractFileByPath(diff.path);
				let uploadFile: PreparedUpload | null = null;
				if (file && 'extension' in file) {
					uploadFile = await this.prepareUpload(file as TFile);
				} else if (hidden) {
					const stat = await this.vault.adapter.stat(diff.path);
					if (stat && stat.type === 'file') {
						uploadFile = await this.prepareUploadFromVaultFile({
							path: diff.path,
							size: stat.size,
							mtime: stat.mtime,
							extension: getExtensionFromPath(diff.path),
						});
					}
				}
				if (uploadFile) {
					const uploadResult = await this.api.uploadFile(
						uploadFile.path,
						uploadFile.content,
						uploadFile.hash,
						uploadFile.size,
						uploadFile.contentType || 'application/octet-stream',
					);
					if (!uploadResult.success) {
						throw new Error(uploadResult.error || 'Upload failed');
					}

					result.uploaded++;
					const modified = await this.getModifiedIso(uploadFile.path, uploadFile.mtime);
					const entry: FileEntry = {
						hash: uploadFile.hash,
						size: uploadFile.size,
						modified,
					};
					this.localManifest.setEntry(uploadFile.path, entry);
					localFiles[uploadFile.path] = entry;
				}
				break;
			}

			case 'download': {
				await this.downloadAndSaveFile(diff.path, result);

				// Update local files record
				const content = await this.vault.adapter.readBinary(diff.path);
				const hash = await computeHash(content);
				localFiles[diff.path] = {
					hash,
					size: content.byteLength,
					modified: await this.getModifiedIso(diff.path),
				};
				break;
			}

			case 'conflict': {
				// Download remote version — already ArrayBuffer
				const response = await this.api.downloadFile(diff.path);
				const remoteContent = response.content;
				if (remoteContent.byteLength > MAX_FILE_SIZE_BYTES) {
					throw new Error('Skipped remote file larger than 25MB');
				}

				// Read local content
				const localFile = this.vault.getAbstractFileByPath(diff.path);
				const hasLocalFile = localFile && 'extension' in localFile;
				const hasHiddenFile = hidden && await this.vault.adapter.exists(diff.path);

				if (hasLocalFile || hasHiddenFile) {
					const localContent = await this.vault.adapter.readBinary(diff.path);

					// Create conflict copy of local version and keep remote at original path.
					const conflictPath = await createConflictCopy(
						this.vault,
						diff.path,
						localContent
					);

					// Replace main file with remote version
					if (hasLocalFile) {
						await this.vault.modifyBinary(localFile as TFile, remoteContent);
					} else {
						await this.vault.adapter.writeBinary(diff.path, remoteContent);
					}

					result.conflicts.push(conflictPath);

					// Update local files record to the remote replacement.
					const hash = await computeHash(remoteContent);
						const entry: FileEntry = {
							hash,
							size: remoteContent.byteLength,
							modified: await this.getModifiedIso(diff.path),
						};
						localFiles[diff.path] = entry;
						this.localManifest.setEntry(diff.path, entry);
					}
					break;
				}

				case 'delete': {
					await this.api.deleteFile(diff.path);
					delete localFiles[diff.path];
					this.localManifest.removeEntry(diff.path);
					result.deleted++;
					break;
				}
		}
	}

	/**
	 * Prepare uploads with bounded concurrency to reduce initial sync wall time.
	 */
	private async prepareUploadsFromVaultFiles(
		files: VaultFile[],
		onPrepared?: (completed: number) => void,
	): Promise<PreparedUpload[]> {
		let completed = 0;

		const tasks = files.map(file => async () => {
			const uploadFile = await this.prepareUploadFromVaultFile(file);
			completed++;
			onPrepared?.(completed);
			return uploadFile;
		});

		const prepared = await this.runConcurrent(tasks, PREPARE_CONCURRENCY);
		return prepared.filter((upload): upload is PreparedUpload => upload !== null);
	}

	/**
	 * Upload prepared files as parallel individual binary uploads
	 */
	private async uploadPreparedFiles(
		prepared: PreparedUpload[],
		result: SyncResult,
		options: { concurrency: number; retry: boolean },
	): Promise<void> {
		if (prepared.length === 0) return;

		logger.info(`Uploading ${prepared.length} files`);

		const tasks = prepared.map(upload => async () => {
			try {
				const doUpload = () => this.api.uploadFile(
					upload.path,
					upload.content,
					upload.hash,
					upload.size,
					upload.contentType || 'application/octet-stream',
				);
				const uploadResult = options.retry
					? await this.retryWithBackoff(doUpload)
					: await doUpload();

				if (uploadResult.success) {
					if (uploadResult.hash && uploadResult.hash !== upload.hash) {
						result.errors.push(`${upload.path}: Hash mismatch after upload (expected ${upload.hash}, got ${uploadResult.hash})`);
						return;
					}
					result.uploaded++;
					this.localManifest.setEntry(upload.path, {
						hash: upload.hash,
						size: upload.size,
						modified: await this.getModifiedIso(upload.path, upload.mtime),
					});
				} else {
					result.errors.push(`${upload.path}: ${uploadResult.error || 'Upload failed'}`);
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Upload failed';
				result.errors.push(`${upload.path}: ${errorMessage}`);
			}
		});

		await this.runConcurrent(tasks, options.concurrency);
	}

	private createVaultFileChunks(files: VaultFile[], chunkSize: number): VaultFile[][] {
		if (files.length === 0) return [];
		const chunks: VaultFile[][] = [];
		for (let i = 0; i < files.length; i += chunkSize) {
			chunks.push(files.slice(i, i + chunkSize));
		}
		return chunks;
	}

	/**
	 * Initial sync - upload all local files
	 */
	async initialSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		if (!this.api.isConfigured()) {
			return {
				success: false,
				uploaded: 0,
				downloaded: 0,
				deleted: 0,
				conflicts: [],
				errors: ['Not configured'],
			};
		}

		this.updateState({ status: 'syncing' });

		const result: SyncResult = {
			success: true,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: [],
			errors: [],
		};

		try {
			const files = await getAllVaultFiles(this.vault, this.shouldIgnore.bind(this));
			logger.info(`Initial sync started with ${files.length} files`);
			const total = files.length;
			let preparedCount = 0;
			let uploadCandidates = 0;

			const chunks = this.createVaultFileChunks(files, INITIAL_SYNC_PIPELINE_CHUNK_FILES);
			const prepareChunk = (chunk: VaultFile[]) => this.prepareUploadsFromVaultFiles(chunk, () => {
				preparedCount++;
				progressCallback?.(preparedCount, total);
			});

			let chunkIndex = 0;
			let currentPrepare = chunks.length > 0 ? prepareChunk(chunks[0]!) : null;
			while (currentPrepare) {
				const preparedChunk = await currentPrepare;
				uploadCandidates += preparedChunk.length;

				chunkIndex++;
				const nextChunk = chunkIndex < chunks.length ? chunks[chunkIndex]! : null;
				const nextPrepare = nextChunk ? prepareChunk(nextChunk) : null;

				if (preparedChunk.length > 0) {
					await this.uploadPreparedFiles(preparedChunk, result, {
						concurrency: UPLOAD_CONCURRENCY,
						retry: true,
					});
				}

				currentPrepare = nextPrepare;
			}

			logger.info(`Prepared ${uploadCandidates}/${total} files for upload (${total - uploadCandidates} unchanged)`);

			await this.localManifest.save();

			const lastSync = new Date().toISOString();
			this.updateState({
				status: 'idle',
				lastSync,
				lastError: null,
			});
			this.settings.lastSync = lastSync;

			logger.info(`Initial sync completed: ${result.uploaded} uploaded`);
			result.success = result.errors.length === 0;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			result.errors.push(errorMessage);
			result.success = false;
			this.updateState({
				status: 'error',
				lastError: errorMessage,
			});
		}

		return result;
	}

	/**
	 * Force full sync - overwrite all remote files with local vault state
	 * Clears local manifest so all files are uploaded regardless of hash,
	 * and deletes remote-only files.
	 */
	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		if (!this.api.isConfigured()) {
			return {
				success: false,
				uploaded: 0,
				downloaded: 0,
				deleted: 0,
				conflicts: [],
				errors: ['Not configured'],
			};
		}

		if (this.state.status === 'syncing') {
			return {
				success: false,
				uploaded: 0,
				downloaded: 0,
				deleted: 0,
				conflicts: [],
				errors: ['Sync already in progress'],
			};
		}

		this.updateState({ status: 'syncing' });

		const result: SyncResult = {
			success: true,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: [],
			errors: [],
		};

		try {
			// Fetch remote manifest to find remote-only files
			const remoteManifest = await this.api.getManifest();
			const remotePaths = new Set(Object.keys(remoteManifest.files));

			// Get local files
			const files = await getAllVaultFiles(this.vault, this.shouldIgnore.bind(this));
			const localPaths = new Set(files.map(f => f.path));

			// Find remote-only paths (to be deleted)
			const remoteOnlyPaths = [...remotePaths].filter(p => !localPaths.has(p));

			const total = files.length + remoteOnlyPaths.length;
			let current = 0;

			// Clear local manifest so prepareUpload won't skip any file
			this.localManifest.clear();

			// First pass: prepare uploads with bounded concurrency (local I/O)
			const prepared = await this.prepareUploadsFromVaultFiles(files, completed => {
				current = completed;
				progressCallback?.(current, total);
			});

			// Second pass: upload individually with retry
			await this.uploadPreparedFiles(prepared, result, {
				concurrency: FORCE_SYNC_CONCURRENCY,
				retry: true,
			});

				// Delete remote-only files
				for (const path of remoteOnlyPaths) {
					try {
						await this.api.deleteFile(path);
						this.localManifest.removeEntry(path);
						result.deleted++;
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : 'Unknown error';
						result.errors.push(`delete ${path}: ${errorMessage}`);
					}
					current++;
					progressCallback?.(current, total);
				}

			await this.localManifest.save();

			const lastSync = new Date().toISOString();
			this.updateState({
				status: 'idle',
				lastSync,
				lastError: null,
			});
			this.settings.lastSync = lastSync;

			logger.info(`Force full sync completed: ${result.uploaded} uploaded, ${result.deleted} remote-only deleted`);
			result.success = result.errors.length === 0;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			result.errors.push(errorMessage);
			result.success = false;
			logger.error('Force full sync failed:', errorMessage);
			this.updateState({
				status: 'error',
				lastError: errorMessage,
			});
		}

		return result;
	}

	/**
	 * Cleanup on unload
	 */
	destroy(): void {
		this.stopPeriodicSync();
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
	}
}
