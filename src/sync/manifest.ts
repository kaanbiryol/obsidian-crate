/**
 * Local manifest management for tracking file state.
 * Stored in its own file (file-manifest.json) in the plugin directory,
 * separate from settings data to avoid write amplification.
 */

import type { App, PluginManifest } from 'obsidian';
import { createLogger } from '../plugin/logger';
import { isRecord } from '../plugin/settings';
import type { FileManifest, FileEntry } from '../plugin/types';

const logger = createLogger('Manifest');

const MANIFEST_FILENAME = 'file-manifest.json';
const MANIFEST_TMP_FILENAME = 'file-manifest.json.tmp';

function normalizeNonNegativeInteger(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeFileEntry(value: unknown): FileEntry | null {
	if (!isRecord(value)) {
		return null;
	}

	const hash = typeof value.hash === 'string' ? value.hash : null;
	const size = normalizeNonNegativeInteger(value.size);
	const modified = typeof value.modified === 'string' ? value.modified : null;
	if (!hash || size === null || !modified) {
		return null;
	}

	return { hash, size, modified };
}

function normalizeFileManifest(value: unknown): FileManifest | null {
	if (!isRecord(value) || !isRecord(value.files)) {
		return null;
	}

	const files: Record<string, FileEntry> = {};
	for (const [path, entry] of Object.entries(value.files)) {
		if (!path.trim()) {
			continue;
		}

		const normalizedEntry = normalizeFileEntry(entry);
		if (normalizedEntry) {
			files[path] = normalizedEntry;
		}
	}

	const version = normalizeNonNegativeInteger(value.version) ?? 1;
	const lastSeq = normalizeNonNegativeInteger(value.lastSeq);
	const truncated = typeof value.truncated === 'boolean' ? value.truncated : undefined;
	return {
		version: version > 0 ? version : 1,
		files,
		...(lastSeq !== null ? { lastSeq } : {}),
		...(truncated !== undefined ? { truncated } : {}),
	};
}

export class LocalManifest {
	private app: App;
	private manifestPath: string;
	private tmpPath: string;
	private manifest: FileManifest;
	private dirty: boolean;

	constructor(app: App, pluginManifest: PluginManifest) {
		this.app = app;
		this.manifestPath = `${pluginManifest.dir}/${MANIFEST_FILENAME}`;
		this.tmpPath = `${pluginManifest.dir}/${MANIFEST_TMP_FILENAME}`;
		this.manifest = { version: 1, files: {} };
		this.dirty = false;
	}

	/**
	 * Load manifest from its dedicated file.
	 * If the main file is corrupt/missing but a .tmp file exists,
	 * recover from the temp file (crash during previous save).
	 */
	async load(): Promise<void> {
		const adapter = this.app.vault.adapter;

		let loaded = false;

		if (await adapter.exists(this.manifestPath)) {
			try {
				const raw = await adapter.read(this.manifestPath);
				const parsed = normalizeFileManifest(JSON.parse(raw));
				if (parsed) {
					this.manifest = parsed;
					loaded = true;
				}
			} catch {
				logger.warn('Main manifest corrupt, attempting recovery from tmp');
			}
		}

		if (!loaded && await adapter.exists(this.tmpPath)) {
			try {
				const raw = await adapter.read(this.tmpPath);
				const parsed = normalizeFileManifest(JSON.parse(raw));
				if (parsed) {
					this.manifest = parsed;
					// Promote recovered tmp to main file
					await adapter.write(this.manifestPath, JSON.stringify(this.manifest));
					loaded = true;
					logger.info('Recovered manifest from tmp file');
				}
			} catch {
				logger.warn('Tmp manifest also corrupt, starting fresh');
			}
		}

		// Clean up leftover tmp file
		if (await adapter.exists(this.tmpPath)) {
			try {
				await adapter.remove(this.tmpPath);
			} catch { /* best effort */ }
		}

		logger.info(`Manifest loaded with ${this.getFileCount()} files`);
	}

	/**
	 * Save manifest to its dedicated file. Skips write if nothing changed.
	 * Writes to a .tmp file first for crash safety — if the process dies
	 * mid-write, the next load() recovers from the tmp file.
	 */
	async save(): Promise<void> {
		if (!this.dirty) return;
		const data = JSON.stringify(this.manifest);
		const adapter = this.app.vault.adapter;
		// Write to tmp first
		await adapter.write(this.tmpPath, data);
		// Write to main
		await adapter.write(this.manifestPath, data);
		// Clean up tmp
		try {
			await adapter.remove(this.tmpPath);
		} catch { /* best effort */ }
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
		this.manifest = normalizeFileManifest(manifest) ?? { version: 1, files: {} };
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
