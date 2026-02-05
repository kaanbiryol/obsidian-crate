/**
 * Local manifest management for tracking file state
 */

import type { Plugin } from 'obsidian';
import { createLogger } from '../logger';
import type { FileManifest, FileEntry } from '../types';

const logger = createLogger('Manifest');

const LOCAL_MANIFEST_KEY = 'crate-local-manifest';

export class LocalManifest {
	private plugin: Plugin;
	private manifest: FileManifest;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
		this.manifest = { version: 1, files: {} };
	}

	/**
	 * Load manifest from plugin data
	 */
	async load(): Promise<void> {
		const data = await this.plugin.loadData() as Record<string, unknown> | null;
		const stored = data?.[LOCAL_MANIFEST_KEY] as FileManifest | undefined;
		if (stored && typeof stored === 'object' && 'version' in stored && 'files' in stored) {
			this.manifest = stored;
		}
		logger.info(`Manifest loaded with ${this.getFileCount()} files`);
	}

	/**
	 * Save manifest to plugin data
	 */
	async save(): Promise<void> {
		const data = await this.plugin.loadData() as Record<string, unknown> | null || {};
		data[LOCAL_MANIFEST_KEY] = this.manifest;
		await this.plugin.saveData(data);
	}

	/**
	 * Get file entry
	 */
	getEntry(path: string): FileEntry | undefined {
		return this.manifest.files[path];
	}

	/**
	 * Set file entry
	 */
	setEntry(path: string, entry: FileEntry): void {
		this.manifest.files[path] = entry;
	}

	/**
	 * Remove file entry
	 */
	removeEntry(path: string): void {
		delete this.manifest.files[path];
	}

	/**
	 * Get all file paths
	 */
	getAllPaths(): string[] {
		return Object.keys(this.manifest.files);
	}

	/**
	 * Get full manifest
	 */
	getManifest(): FileManifest {
		return this.manifest;
	}

	/**
	 * Replace entire manifest (used after remote sync)
	 */
	replaceManifest(manifest: FileManifest): void {
		this.manifest = manifest;
	}

	/**
	 * Check if file exists in manifest
	 */
	hasFile(path: string): boolean {
		return path in this.manifest.files;
	}

	/**
	 * Check if file hash matches
	 */
	hashMatches(path: string, hash: string): boolean {
		const entry = this.manifest.files[path];
		return entry?.hash === hash;
	}

	/**
	 * Get file count
	 */
	getFileCount(): number {
		return Object.keys(this.manifest.files).length;
	}

	/**
	 * Clear manifest
	 */
	clear(): void {
		this.manifest = { version: 1, files: {} };
	}
}
