/**
 * Core sync engine - orchestrates synchronization between local vault and remote storage
 */

import type { Plugin, TFile, TAbstractFile, Vault } from 'obsidian';
import { Notice } from 'obsidian';
import { SyncApiClient } from './api';
import { LocalManifest } from './manifest';
import { computeHash } from './hasher';
import { detectConflicts, createConflictCopy, isConflictFile } from './conflict';
import { createLogger } from '../logger';
import type {
	SyncState,
	SyncResult,
	FileDiff,
	UploadFile,
	FileEntry,
	CrateSettings,
	ChangelogEntry,
	DEBOUNCE_DELAY_MS,
	MAX_FILE_SIZE_BYTES,
} from '../types';

const logger = createLogger('SyncEngine');
const UPLOAD_CONCURRENCY = 5;
const FORCE_SYNC_CONCURRENCY = 2;
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

	constructor(
		plugin: Plugin,
		api: SyncApiClient,
		settings: CrateSettings
	) {
		this.plugin = plugin;
		this.vault = plugin.app.vault;
		this.api = api;
		this.settings = settings;
		this.localManifest = new LocalManifest(plugin);
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
			() => this.sync(),
			this.settings.syncInterval * 1000
		);
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

		for (const pattern of this.settings.ignorePatterns) {
			if (this.matchPattern(path, pattern)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Simple glob pattern matching
	 */
	private matchPattern(path: string, pattern: string): boolean {
		// Convert glob pattern to regex
		const regexPattern = pattern
			.replace(/\./g, '\\.')
			.replace(/\*/g, '.*')
			.replace(/\?/g, '.');

		const regex = new RegExp(`^${regexPattern}$`);
		return regex.test(path);
	}

	/**
	 * Handle file change (create, modify)
	 */
	onFileChange(file: TAbstractFile): void {
		if (!(file instanceof this.plugin.app.vault.adapter.constructor)) {
			// It's a file, not a folder
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
		}, 2000); // DEBOUNCE_DELAY_MS
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
						const tfile = file as TFile;
						const uploadFile = await this.prepareUpload(tfile);
						if (uploadFile) {
							uploads.push(uploadFile);
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
	 * Prepare a file for upload
	 */
	private async prepareUpload(file: TFile): Promise<UploadFile | null> {
		// Check file size
		if (file.stat.size > 5 * 1024 * 1024) { // MAX_FILE_SIZE_BYTES
			logger.warn('Skipping large file:', file.path);
			return null;
		}

		const content = await this.vault.readBinary(file);
		const hash = await computeHash(content);

		// Check if file actually changed
		if (this.localManifest.hashMatches(file.path, hash)) {
			logger.debug('Skipping unchanged file:', file.path);
			return null;
		}

		// Determine if binary
		const textExtensions = ['md', 'txt', 'json', 'css', 'js', 'ts', 'html', 'xml', 'yaml', 'yml'];
		const isBinary = !textExtensions.includes(file.extension.toLowerCase());

		let contentStr: string;
		if (isBinary) {
			// Base64 encode binary content
			const bytes = new Uint8Array(content);
			let binary = '';
			for (let i = 0; i < bytes.byteLength; i++) {
				binary += String.fromCharCode(bytes[i]!);
			}
			contentStr = btoa(binary);
		} else {
			// Text content as-is
			const decoder = new TextDecoder();
			contentStr = decoder.decode(content);
		}

		return {
			path: file.path,
			content: contentStr,
			hash,
			size: file.stat.size,
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
	private async incrementalSync(): Promise<SyncResult | null> {
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

			if (allChanges.length === 0) {
				// Check for local-only changes
				const localUploads = await this.getLocalChanges();
				if (localUploads.length === 0) {
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

			// Find locally modified files
			const localChanges = await this.getLocalChanges();
			logger.info(`Incremental sync: ${localChanges.length} local changes detected`);
			const localChangedPaths = new Set(localChanges.map(f => f.path));

			// Process remote changes
			for (const [path, entry] of changesByPath) {
				if (this.shouldIgnore(path)) continue;

				try {
					if (entry.action === 'delete') {
						const file = this.vault.getAbstractFileByPath(path);
						if (file) {
							await this.vault.delete(file);
							this.localManifest.removeEntry(path);
							result.deleted++;
						}
					} else if (entry.action === 'put') {
						const localFile = this.vault.getAbstractFileByPath(path);

						if (!localFile) {
							// No local file — download
							await this.downloadAndSaveFile(path, result);
						} else if ('extension' in localFile) {
							const tfile = localFile as TFile;
							const content = await this.vault.readBinary(tfile);
							const localHash = await computeHash(content);

							if (localHash === entry.hash) {
								// Already matches — skip
								this.localManifest.setEntry(path, {
									hash: localHash,
									size: tfile.stat.size,
									modified: new Date(tfile.stat.mtime).toISOString(),
								});
							} else if (localChangedPaths.has(path)) {
								// Conflict: both sides changed
								const diff: FileDiff = {
									path,
									action: 'conflict',
									localHash,
									remoteHash: entry.hash,
								};
								const localFiles: Record<string, FileEntry> = {};
								await this.processDiff(diff, localFiles, result);
							} else {
								// Remote changed, local didn't — download
								await this.downloadAndSaveFile(path, result);
							}
						}
					}
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					result.errors.push(`${path}: ${errorMessage}`);
				}
			}

			// Upload local-only changes (modified locally but not in remote changeset)
			for (const file of localChanges) {
				if (changesByPath.has(file.path)) continue;
				if (this.shouldIgnore(file.path)) continue;

				try {
					const tfile = this.vault.getAbstractFileByPath(file.path);
					if (tfile && 'extension' in tfile) {
						const uploadFile = await this.prepareUpload(tfile as TFile);
						if (uploadFile) {
							await this.api.uploadFiles([uploadFile]);
							this.localManifest.setEntry(uploadFile.path, {
								hash: uploadFile.hash,
								size: uploadFile.size,
								modified: new Date().toISOString(),
							});
							result.uploaded++;
						}
					}
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					result.errors.push(`${file.path}: ${errorMessage}`);
				}
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
		const lastSyncTime = this.settings.lastSync ? new Date(this.settings.lastSync).getTime() : 0;

		for (const file of this.vault.getFiles()) {
			if (this.shouldIgnore(file.path)) continue;
			if (file.stat.size > 5 * 1024 * 1024) continue; // MAX_FILE_SIZE_BYTES

			if (file.stat.mtime > lastSyncTime) {
				const content = await this.vault.readBinary(file);
				const hash = await computeHash(content);

				if (!this.localManifest.hashMatches(file.path, hash)) {
					changes.push({ path: file.path, hash });
				}
			}
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
			try {
				await this.vault.createFolder(folderPath);
			} catch {
				// Folder might already exist
			}
		}

		const existingFile = this.vault.getAbstractFileByPath(path);
		if (existingFile) {
			await this.vault.modifyBinary(existingFile as TFile, content);
		} else {
			await this.vault.createBinary(path, content);
		}

		const hash = await computeHash(content);
		this.localManifest.setEntry(path, {
			hash,
			size: content.byteLength,
			modified: new Date().toISOString(),
		});

		result.downloaded++;
	}

	/**
	 * Full sync - compare manifests and sync all differences
	 */
	async sync(): Promise<SyncResult> {
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
		const incrementalResult = await this.incrementalSync();
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
			const files = this.vault.getFiles();

			for (const file of files) {
				if (this.shouldIgnore(file.path)) continue;
				if (file.stat.size > 5 * 1024 * 1024) continue; // MAX_FILE_SIZE_BYTES

				const content = await this.vault.readBinary(file);
				const hash = await computeHash(content);

				localFiles[file.path] = {
					hash,
					size: file.stat.size,
					modified: new Date(file.stat.mtime).toISOString(),
				};
			}

			// Detect differences
			const diffs = detectConflicts(
				localFiles,
				remoteManifest.files,
				this.state.lastSync
			);

			// Process differences — parallelize uploads, keep others sequential
			const uploadDiffs = diffs.filter(d => d.action === 'upload');
			const downloadDiffs = diffs.filter(d => d.action === 'download');
			const conflictDiffs = diffs.filter(d => d.action === 'conflict');
			const deleteDiffs = diffs.filter(d => d.action === 'delete');
			const otherDiffs = diffs.filter(d => d.action !== 'upload');
			logger.info(`Full sync diffs: ${uploadDiffs.length} upload, ${downloadDiffs.length} download, ${conflictDiffs.length} conflict, ${deleteDiffs.length} delete`);

			// Run upload diffs concurrently
			if (uploadDiffs.length > 0) {
				const uploadTasks = uploadDiffs.map(diff => async () => {
					try {
						await this.processDiff(diff, localFiles, result);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : 'Unknown error';
						result.errors.push(`${diff.path}: ${errorMessage}`);
					}
				});
				await this.runConcurrent(uploadTasks, UPLOAD_CONCURRENCY);
			}

			// Run download/delete/conflict diffs sequentially
			for (const diff of otherDiffs) {
				try {
					await this.processDiff(diff, localFiles, result);
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					result.errors.push(`${diff.path}: ${errorMessage}`);
				}
			}

			// Get and process tombstones
			const tombstones = await this.api.getTombstones();
			for (const tombstone of tombstones.deleted) {
				const file = this.vault.getAbstractFileByPath(tombstone.path);
				if (file) {
					await this.vault.delete(file);
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
		switch (diff.action) {
			case 'upload': {
				const file = this.vault.getAbstractFileByPath(diff.path);
				if (file && 'extension' in file) {
					const uploadFile = await this.prepareUpload(file as TFile);
					if (uploadFile) {
						await this.api.uploadFiles([uploadFile]);
						result.uploaded++;
					}
				}
				break;
			}

			case 'download': {
				const response = await this.api.downloadFile(diff.path);
				const content = this.decodeContent(response.content, response.contentType);

				// Create parent folders if needed
				const folderPath = diff.path.substring(0, diff.path.lastIndexOf('/'));
				if (folderPath) {
					try {
						await this.vault.createFolder(folderPath);
					} catch {
						// Folder might already exist
					}
				}

				const existingFile = this.vault.getAbstractFileByPath(diff.path);
				if (existingFile) {
					await this.vault.modifyBinary(existingFile as TFile, content);
				} else {
					await this.vault.createBinary(diff.path, content);
				}

				// Update local files record
				const hash = await computeHash(content);
				localFiles[diff.path] = {
					hash,
					size: content.byteLength,
					modified: new Date().toISOString(),
				};

				result.downloaded++;
				break;
			}

			case 'conflict': {
				// Download remote version
				const response = await this.api.downloadFile(diff.path);
				const remoteContent = this.decodeContent(response.content, response.contentType);

				// Read local content
				const localFile = this.vault.getAbstractFileByPath(diff.path);
				if (localFile && 'extension' in localFile) {
					const localContent = await this.vault.readBinary(localFile as TFile);

					// Create conflict copy of local version
					const conflictPath = await createConflictCopy(
						this.vault,
						diff.path,
						localContent
					);

					// Replace main file with remote version
					await this.vault.modifyBinary(localFile as TFile, remoteContent);

					result.conflicts.push(conflictPath);

					// Update local files record
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
			const files = this.vault.getFiles().filter(f => !this.shouldIgnore(f.path));
			logger.info(`Initial sync started with ${files.length} files`);
			const total = files.length;
			let current = 0;

			// First pass: prepare all uploads sequentially (local I/O)
			const prepared: UploadFile[] = [];
			for (const file of files) {
				const uploadFile = await this.prepareUpload(file);
				if (uploadFile) {
					prepared.push(uploadFile);
				}
				current++;
				progressCallback?.(current, total);
			}

			logger.info(`Prepared ${prepared.length}/${total} files for upload (${total - prepared.length} unchanged)`);

			// Second pass: upload concurrently
			const uploadTasks = prepared.map(upload => async () => {
				logger.info('Uploading:', upload.path, `(${upload.size} bytes)`);
				const response = await this.api.uploadFiles([upload]);
				const uploadResult = response.results[0];
				if (uploadResult?.success) {
					result.uploaded++;
					this.localManifest.setEntry(upload.path, {
						hash: upload.hash,
						size: upload.size,
						modified: new Date().toISOString(),
					});
				} else if (uploadResult?.error) {
					result.errors.push(`${upload.path}: ${uploadResult.error}`);
				}
			});

			await this.runConcurrent(uploadTasks, UPLOAD_CONCURRENCY);

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
			const files = this.vault.getFiles().filter(f => !this.shouldIgnore(f.path));
			const localPaths = new Set(files.map(f => f.path));

			// Find remote-only paths (to be deleted)
			const remoteOnlyPaths = [...remotePaths].filter(p => !localPaths.has(p));

			const total = files.length + remoteOnlyPaths.length;
			let current = 0;

			// Clear local manifest so prepareUpload won't skip any file
			this.localManifest.clear();

			// First pass: prepare all uploads sequentially (local I/O)
			const prepared: UploadFile[] = [];
			for (const file of files) {
				const uploadFile = await this.prepareUpload(file);
				if (uploadFile) {
					prepared.push(uploadFile);
				}
				current++;
				progressCallback?.(current, total);
			}

			// Second pass: upload with lower concurrency and retry
			const uploadTasks = prepared.map(upload => async () => {
				const response = await this.retryWithBackoff(() => this.api.uploadFiles([upload]));
				const uploadResult = response.results[0];
				if (uploadResult?.success) {
					result.uploaded++;
					this.localManifest.setEntry(upload.path, {
						hash: upload.hash,
						size: upload.size,
						modified: new Date().toISOString(),
					});
				} else if (uploadResult?.error) {
					result.errors.push(`${upload.path}: ${uploadResult.error}`);
				}
			});

			await this.runConcurrent(uploadTasks, FORCE_SYNC_CONCURRENCY);

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
