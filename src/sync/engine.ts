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
	DEBOUNCE_DELAY_MS,
	MAX_FILE_SIZE_BYTES,
} from '../types';

const logger = createLogger('SyncEngine');

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

			// Upload changed files
			if (uploads.length > 0) {
				const response = await this.api.uploadFiles(uploads);
				for (const result of response.results) {
					if (result.success) {
						const upload = uploads.find(u => u.path === result.path);
						if (upload) {
							this.localManifest.setEntry(result.path, {
								hash: upload.hash,
								size: upload.size,
								modified: new Date().toISOString(),
							});
						}
					}
				}
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

		logger.info('Full sync started');
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

			// Process differences
			for (const diff of diffs) {
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

			// Save last sync time to settings
			this.settings.lastSync = lastSync;

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

			// Upload in batches
			const batchSize = 10;
			for (let i = 0; i < files.length; i += batchSize) {
				const batch = files.slice(i, i + batchSize);
				const uploads: UploadFile[] = [];

				for (const file of batch) {
					const uploadFile = await this.prepareUpload(file);
					if (uploadFile) {
						uploads.push(uploadFile);
					}
					current++;
					progressCallback?.(current, total);
				}

				if (uploads.length > 0) {
					const response = await this.api.uploadFiles(uploads);
					for (const uploadResult of response.results) {
						if (uploadResult.success) {
							result.uploaded++;
							const upload = uploads.find(u => u.path === uploadResult.path);
							if (upload) {
								this.localManifest.setEntry(uploadResult.path, {
									hash: upload.hash,
									size: upload.size,
									modified: new Date().toISOString(),
								});
							}
						} else if (uploadResult.error) {
							result.errors.push(`${uploadResult.path}: ${uploadResult.error}`);
						}
					}
				}
			}

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
	 * Cleanup on unload
	 */
	destroy(): void {
		this.stopPeriodicSync();
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
	}
}
