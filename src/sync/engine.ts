/**
 * Core sync engine - orchestrates synchronization between local vault and remote storage
 */

import type { Plugin, TFile, TAbstractFile, Vault } from 'obsidian';
import { Notice, TFolder } from 'obsidian';
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
	UploadFile,
	UploadResponse,
	FileEntry,
	CrateSettings,
	ChangelogEntry,
	DEBOUNCE_DELAY_MS,
	MAX_FILE_SIZE_BYTES,
} from '../types';

const logger = createLogger('SyncEngine');
const UPLOAD_CONCURRENCY = 5;
const FORCE_SYNC_CONCURRENCY = 2;
const PREPARE_CONCURRENCY = 3;
const MAX_UPLOAD_BATCH_FILES = 10;
const MAX_UPLOAD_BATCH_BYTES = 5 * 1024 * 1024; // Keep well below Cloudflare request limits
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

		// Ignore base cache files
		if (path.startsWith('.obsidian/plugins/obsidian-crate/bases/')) {
			return true;
		}

		for (const pattern of this.settings.ignorePatterns) {
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
		}, 10000); // DEBOUNCE_DELAY_MS
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
		this.pendingPaths.clear();

		this.updateState({ status: 'syncing', pendingChanges: 0 });

		try {
			const uploads: UploadFile[] = [];
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
					const response = await this.api.uploadFiles([upload]);
					const uploadResult = response.results[0];
					if (uploadResult?.success) {
						this.localManifest.setEntry(upload.path, {
							hash: upload.hash,
							size: upload.size,
							modified: new Date().toISOString(),
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
			this.updateState({
				status: 'idle',
				lastSync: new Date().toISOString(),
				lastError: null,
			});
		} catch (error) {
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
	private async prepareUpload(file: TFile): Promise<UploadFile | null> {
		return this.prepareUploadFromVaultFile(tfileToVaultFile(file));
	}

	/**
	 * Prepare a VaultFile for upload — works for both indexed and hidden files.
	 * Reads content via the low-level adapter so hidden files are supported.
	 */
	private async prepareUploadFromVaultFile(file: VaultFile): Promise<UploadFile | null> {
		// Check file size
		if (file.size > 5 * 1024 * 1024) { // MAX_FILE_SIZE_BYTES
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

		// Determine if binary
		const textExtensions = ['md', 'txt', 'json', 'css', 'js', 'ts', 'html', 'xml', 'yaml', 'yml'];
		const ext = file.extension.toLowerCase();
		const isBinary = !textExtensions.includes(ext);

		let contentStr: string;
		if (isBinary) {
			// Base64 encode binary content
			const bytes = new Uint8Array(content);
			const chunks: string[] = [];
			for (let i = 0; i < bytes.byteLength; i += 8192) {
				chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
			}
			contentStr = btoa(chunks.join(''));
		} else {
			// Text content as-is
			const decoder = new TextDecoder();
			contentStr = decoder.decode(content);
		}

		return {
			path: file.path,
			content: contentStr,
			hash,
			size: file.size,
			binary: isBinary,
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
				// Move cursor to last fetched seq for next page
				since = response.changes[response.changes.length - 1]!.seq;
			}

			logger.info(`Incremental sync: ${allChanges.length} remote changes since seq ${this.settings.lastSeq}`);

			// Get local changes once, reuse for early-exit check and main logic
			const localChanges = await this.getLocalChanges();
			logger.info(`Incremental sync: ${localChanges.length} local changes detected`);

			if (allChanges.length === 0 && localChanges.length === 0) {
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

			// Count local changes that won't be skipped (not already in remote changeset)
			const localOnlyChanges = localChanges.filter(f => !changesByPath.has(f.path) && !this.shouldIgnore(f.path));
			const total = changesByPath.size + localOnlyChanges.length;
			let current = 0;

			// Categorize remote changes
			const downloadPaths: string[] = [];
			const conflicts: FileDiff[] = [];

			for (const [path, entry] of changesByPath) {
				if (this.shouldIgnore(path)) continue;

				try {
					if (entry.action === 'delete') {
						const file = this.vault.getAbstractFileByPath(path);
						if (file) {
							await this.vault.delete(file);
						} else if (await this.vault.adapter.exists(path)) {
							await this.vault.adapter.remove(path);
						}
						this.localManifest.removeEntry(path);
						result.deleted++;
					} else if (entry.action === 'put') {
						const localFile = this.vault.getAbstractFileByPath(path);

						if (!localFile && !(isHiddenPath(path) && await this.vault.adapter.exists(path))) {
							downloadPaths.push(path);
						} else {
							const content = await this.vault.adapter.readBinary(path);
							const localHash = await computeHash(content);
							const stat = localFile && 'stat' in localFile
								? (localFile as TFile).stat
								: await this.vault.adapter.stat(path);

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

			// Batch download remote files
			if (downloadPaths.length > 0) {
				await this.batchDownloadAndSaveFiles(downloadPaths, result);
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
			const localOnlyUploads: UploadFile[] = [];
			for (const file of localOnlyChanges) {
				try {
					const tfile = this.vault.getAbstractFileByPath(file.path);
					let uploadFile: UploadFile | null = null;
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
		const lastSyncTime = this.settings.lastSync ? new Date(this.settings.lastSync).getTime() : 0;

		const allFiles = await getAllVaultFiles(this.vault, this.shouldIgnore.bind(this));

		const candidates = allFiles.filter(
			file => file.size <= 5 * 1024 * 1024 && file.mtime > lastSyncTime
		);

		const tasks = candidates.map(file => async () => {
			const content = await this.vault.adapter.readBinary(file.path);
			const hash = await computeHash(content);
			if (!this.localManifest.hashMatches(file.path, hash)) {
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
		const content = this.decodeContent(response.content, response.contentType);

		// Create parent folders if needed
		const folderPath = path.substring(0, path.lastIndexOf('/'));
		if (folderPath) {
			if (isHiddenPath(path)) {
				// Use adapter.mkdir for hidden paths (vault.createFolder rejects dot-prefixed names)
				try {
					await this.vault.adapter.mkdir(folderPath);
				} catch {
					// Folder might already exist
				}
			} else {
				try {
					await this.vault.createFolder(folderPath);
				} catch {
					// Folder might already exist
				}
			}
		}

		if (isHiddenPath(path)) {
			// Hidden files: always use adapter
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
			modified: new Date().toISOString(),
		});

		result.downloaded++;
	}

	private async saveDownloadedContent(path: string, content: ArrayBuffer): Promise<void> {
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
			modified: new Date().toISOString(),
		});
	}

	private async batchDownloadAndSaveFiles(paths: string[], result: SyncResult): Promise<void> {
		const MAX_DOWNLOAD_BATCH = 20;
		for (let i = 0; i < paths.length; i += MAX_DOWNLOAD_BATCH) {
			const batch = paths.slice(i, i + MAX_DOWNLOAD_BATCH);
			const response = await this.api.batchDownload(batch);
			for (const file of response.files) {
				if (file.error || !file.content) {
					result.errors.push(`${file.path}: ${file.error || 'Download failed'}`);
					continue;
				}
				const content = this.decodeContent(file.content, file.contentType || 'application/octet-stream');
				await this.saveDownloadedContent(file.path, content);
				result.downloaded++;
			}
		}
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

			const hashTasks = files
				.filter(file => file.size <= 5 * 1024 * 1024)
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

			// Detect differences
			const diffs = detectConflicts(
				localFiles,
				remoteManifest.files,
				this.state.lastSync
			);

			// Process differences — uploads concurrent, downloads batched, rest sequential
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

			// Batch download diffs
			if (downloadDiffs.length > 0) {
				await this.batchDownloadAndSaveFiles(
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
							modified: new Date().toISOString(),
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
				let uploadFile: UploadFile | null = null;
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
					await this.api.uploadFiles([uploadFile]);
					result.uploaded++;
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
					modified: new Date().toISOString(),
				};
				break;
			}

			case 'conflict': {
				// Download remote version
				const response = await this.api.downloadFile(diff.path);
				const remoteContent = this.decodeContent(response.content, response.contentType);

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
					localFiles[diff.path] = {
						hash,
						size: remoteContent.byteLength,
						modified: new Date().toISOString(),
					};
				}
				break;
			}

			case 'delete': {
				await this.api.deleteFile(diff.path);
				delete localFiles[diff.path];
				result.deleted++;
				break;
			}
		}
	}

	/**
	 * Decode content from base64
	 */
	private decodeContent(base64: string, contentType: string): ArrayBuffer {
		const binaryString = atob(base64);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes.buffer as ArrayBuffer;
	}

	/**
	 * Prepare uploads with bounded concurrency to reduce initial sync wall time.
	 */
	private async prepareUploadsFromVaultFiles(
		files: VaultFile[],
		onPrepared?: (completed: number) => void,
	): Promise<UploadFile[]> {
		let completed = 0;

		const tasks = files.map(file => async () => {
			const uploadFile = await this.prepareUploadFromVaultFile(file);
			completed++;
			onPrepared?.(completed);
			return uploadFile;
		});

		const prepared = await this.runConcurrent(tasks, PREPARE_CONCURRENCY);
		return prepared.filter((upload): upload is UploadFile => upload !== null);
	}

	private estimateUploadPayloadBytes(upload: UploadFile): number {
		// Base64 payloads are ASCII; text can contain multibyte chars.
		const contentBytes = upload.binary ? upload.content.length : upload.content.length * 2;
		const metadataBytes = upload.path.length + upload.hash.length + (upload.contentType?.length ?? 0) + 256;
		return contentBytes + metadataBytes;
	}

	private createUploadBatches(uploads: UploadFile[]): UploadFile[][] {
		const batches: UploadFile[][] = [];
		let currentBatch: UploadFile[] = [];
		let currentBytes = 32; // JSON envelope overhead

		for (const upload of uploads) {
			const uploadBytes = this.estimateUploadPayloadBytes(upload);
			const exceedsFileLimit = currentBatch.length >= MAX_UPLOAD_BATCH_FILES;
			const exceedsByteLimit = currentBatch.length > 0 && (currentBytes + uploadBytes) > MAX_UPLOAD_BATCH_BYTES;

			if (exceedsFileLimit || exceedsByteLimit) {
				batches.push(currentBatch);
				currentBatch = [];
				currentBytes = 32;
			}

			currentBatch.push(upload);
			currentBytes += uploadBytes;
		}

		if (currentBatch.length > 0) {
			batches.push(currentBatch);
		}

		return batches;
	}

	private shouldSplitUploadBatch(error: unknown): boolean {
		if (!(error instanceof Error)) return false;
		const message = error.message.toLowerCase();
		return (
			message.includes('http 413') ||
			message.includes('payload') ||
			message.includes('too large') ||
			message.includes('request body') ||
			message.includes('http 429') ||
			message.includes('rate') ||
			message.includes('cpu') ||
			message.includes('1102')
		);
	}

	private async uploadBatchWithAdaptiveSplit(batch: UploadFile[], retry: boolean): Promise<UploadResponse> {
		const upload = () => this.api.uploadFiles(batch);

		try {
			return retry ? await this.retryWithBackoff(upload) : await upload();
		} catch (error) {
			if (batch.length <= 1 || !this.shouldSplitUploadBatch(error)) {
				throw error;
			}

			const mid = Math.ceil(batch.length / 2);
			const leftBatch = batch.slice(0, mid);
			const rightBatch = batch.slice(mid);
			logger.warn(`Batch upload failed for ${batch.length} files, retrying as ${leftBatch.length}+${rightBatch.length}`);

			const left = await this.uploadBatchWithAdaptiveSplit(leftBatch, retry);
			const right = await this.uploadBatchWithAdaptiveSplit(rightBatch, retry);

			return {
				success: left.success && right.success,
				results: [...left.results, ...right.results],
			};
		}
	}

	private async applyUploadBatchResults(
		batch: UploadFile[],
		response: UploadResponse,
		result: SyncResult,
	): Promise<void> {
		const resultsByPath = new Map(response.results.map(entry => [entry.path, entry]));

		for (const upload of batch) {
			const uploadResult = resultsByPath.get(upload.path);
			if (uploadResult?.success) {
				result.uploaded++;
				this.localManifest.setEntry(upload.path, {
					hash: upload.hash,
					size: upload.size,
					modified: new Date().toISOString(),
				});
			} else if (uploadResult?.error) {
				result.errors.push(`${upload.path}: ${uploadResult.error}`);
			} else {
				result.errors.push(`${upload.path}: Upload failed`);
			}
		}
	}

	private async uploadPreparedFiles(
		prepared: UploadFile[],
		result: SyncResult,
		options: { concurrency: number; retry: boolean },
	): Promise<void> {
		if (prepared.length === 0) return;

		const batches = this.createUploadBatches(prepared);
		logger.info(`Uploading ${prepared.length} files in ${batches.length} batch(es)`);

		const tasks = batches.map(batch => async () => {
			const response = await this.uploadBatchWithAdaptiveSplit(batch, options.retry);
			await this.applyUploadBatchResults(batch, response, result);
		});

		await this.runConcurrent(tasks, options.concurrency);
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
			const prepared = await this.prepareUploadsFromVaultFiles(files, current => {
				progressCallback?.(current, total);
			});

			logger.info(`Prepared ${prepared.length}/${total} files for upload (${total - prepared.length} unchanged)`);

			// Second pass: upload in adaptive batches
			await this.uploadPreparedFiles(prepared, result, {
				concurrency: UPLOAD_CONCURRENCY,
				retry: false,
			});

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

			// Second pass: upload in adaptive batches with retry
			await this.uploadPreparedFiles(prepared, result, {
				concurrency: FORCE_SYNC_CONCURRENCY,
				retry: true,
			});

			// Delete remote-only files
			for (const path of remoteOnlyPaths) {
				try {
					await this.api.deleteFile(path);
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
