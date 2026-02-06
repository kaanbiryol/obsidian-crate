/**
 * Local manifest management for tracking file state.
 * Stored in its own file (file-manifest.json) in the plugin directory,
 * separate from Obsidian's data.json to avoid write amplification
 * and prevent settings saves from erasing manifest data.
 */

import type { App, PluginManifest } from 'obsidian';
import { createLogger } from '../logger';
import type { FileManifest, FileEntry } from '../types';

const logger = createLogger('Manifest');

const MANIFEST_FILENAME = 'file-manifest.json';
const LEGACY_MANIFEST_KEY = 'crate-local-manifest';

export class LocalManifest {
	private app: App;
	private manifestPath: string;
	private dataPath: string;
	private manifest: FileManifest;
	private dirty: boolean;

	constructor(app: App, pluginManifest: PluginManifest) {
		this.app = app;
		this.manifestPath = `${pluginManifest.dir}/${MANIFEST_FILENAME}`;
		this.dataPath = `${pluginManifest.dir}/data.json`;
		this.manifest = { version: 1, files: {} };
		this.dirty = false;
	}

	/**
	 * Load manifest from its dedicated file, migrating from data.json if needed.
	 */
	async load(): Promise<void> {
		const adapter = this.app.vault.adapter;

		if (await adapter.exists(this.manifestPath)) {
			// New file exists — read it directly
			const raw = await adapter.read(this.manifestPath);
			const parsed = JSON.parse(raw) as FileManifest;
			if (parsed && typeof parsed === 'object' && 'version' in parsed && 'files' in parsed) {
				this.manifest = parsed;
			}
		} else if (await adapter.exists(this.dataPath)) {
			// Attempt migration from legacy location in data.json
			const raw = await adapter.read(this.dataPath);
			const data = JSON.parse(raw) as Record<string, unknown>;
			const stored = data?.[LEGACY_MANIFEST_KEY] as FileManifest | undefined;

			if (stored && typeof stored === 'object' && 'version' in stored && 'files' in stored) {
				this.manifest = stored;
				this.dirty = true;

				// Write to new location immediately
				await this.save();

				// Remove the legacy key from data.json
				delete data[LEGACY_MANIFEST_KEY];
				await adapter.write(this.dataPath, JSON.stringify(data));
				logger.info('Migrated manifest from data.json to file-manifest.json');
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
