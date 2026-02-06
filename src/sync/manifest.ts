/**
 * Local manifest management for tracking file state.
 * Stored in its own file (file-manifest.json) in the plugin directory,
 * separate from settings data to avoid write amplification.
 */

import type { App, PluginManifest } from 'obsidian';
import { createLogger } from '../logger';
import type { FileManifest, FileEntry } from '../types';

const logger = createLogger('Manifest');

const MANIFEST_FILENAME = 'file-manifest.json';

export class LocalManifest {
	private app: App;
	private manifestPath: string;
	private manifest: FileManifest;
	private dirty: boolean;

	constructor(app: App, pluginManifest: PluginManifest) {
		this.app = app;
		this.manifestPath = `${pluginManifest.dir}/${MANIFEST_FILENAME}`;
		this.manifest = { version: 1, files: {} };
		this.dirty = false;
	}

	/**
	 * Load manifest from its dedicated file.
	 */
	async load(): Promise<void> {
		const adapter = this.app.vault.adapter;

		if (await adapter.exists(this.manifestPath)) {
			const raw = await adapter.read(this.manifestPath);
			const parsed = JSON.parse(raw) as FileManifest;
			if (parsed && typeof parsed === 'object' && 'version' in parsed && 'files' in parsed) {
				this.manifest = parsed;
			}
		}

		logger.info(`Manifest loaded with ${this.getFileCount()} files`);
	}

	/**
	 * Save manifest to its dedicated file. Skips write if nothing changed.
	 */
	async save(): Promise<void> {
		if (!this.dirty) return;
		await this.app.vault.adapter.write(
			this.manifestPath,
			JSON.stringify(this.manifest)
		);
		this.dirty = false;
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
		this.dirty = true;
	}

	/**
	 * Remove file entry
	 */
	removeEntry(path: string): void {
		delete this.manifest.files[path];
		this.dirty = true;
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
		this.dirty = true;
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
		this.dirty = true;
	}
}
