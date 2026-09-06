/**
 * Local manifest management for tracking file state.
 * Stored in its own file (file-manifest.json) in the plugin directory,
 * separate from settings data to avoid write amplification.
 */

import type { App, PluginManifest } from 'obsidian';
import { createLogger } from '../plugin/logger';
import { isRecord } from '../plugin/settings';
import type { FileManifest, FileEntry } from '../protocol/sync-types';

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

	return { hash, size, modified, ...(typeof value.revision === 'string' ? { revision: value.revision } : {}) };
}

function normalizeFileManifest(value: unknown): FileManifest | null {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.files)) {
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

	const lastSeq = normalizeNonNegativeInteger(value.lastSeq);
	const truncated = typeof value.truncated === 'boolean' ? value.truncated : undefined;
	return {
		version: 1,
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
	private revision = 0;
	private generation = 0;
	private saveChain: Promise<void> = Promise.resolve();

	constructor(app: App, pluginManifest: PluginManifest) {
		this.app = app;
		this.manifestPath = `${pluginManifest.dir}/${MANIFEST_FILENAME}`;
		this.tmpPath = `${pluginManifest.dir}/${MANIFEST_TMP_FILENAME}`;
		this.manifest = { version: 1, files: {} };
		this.dirty = false;
	}

	/**
	 * Load manifest from its dedicated file.
	 * Select the newest valid main or temporary generation after a crash.
	 */
	async load(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const read = async (path: string) => {
			try {
				if (!await adapter.exists(path)) return null;
				const parsed: unknown = JSON.parse(await adapter.read(path));
				const manifest = normalizeFileManifest(parsed);
				if (!manifest) return null;
				const generation = isRecord(parsed) ? normalizeNonNegativeInteger(parsed.generation) : null;
				if (generation === null) return null;
				return { manifest, generation };
			} catch {
				logger.warn(`Could not read manifest checkpoint: ${path}`);
				return null;
			}
		};
		const main = await read(this.manifestPath);
		const tmp = await read(this.tmpPath);
		const recoverTmp = tmp && (!main || tmp.generation > main.generation);
		const selected = recoverTmp ? tmp : main;
		if (!selected && (await adapter.exists(this.manifestPath) || await adapter.exists(this.tmpPath))) {
			throw new Error('Invalid manifest checkpoint. Preserve this vault and its metadata before resetting sync.');
		}
		if (selected) {
			this.manifest = selected.manifest;
			this.generation = selected.generation;
			if (recoverTmp) {
				// Leave tmp intact if promotion fails, so the next load can retry.
				await adapter.write(this.manifestPath, JSON.stringify({ ...this.manifest, generation: this.generation }));
				logger.info('Recovered newer manifest checkpoint');
			}
		}
		if (await adapter.exists(this.tmpPath)) {
			try { await adapter.remove(this.tmpPath); } catch { /* best effort */ }
		}
		logger.info(`Manifest loaded with ${this.getFileCount()} files`);
	}

	/** Serialize checkpoints and include changes made while disk writes await. */
	save(): Promise<void> {
		const save = this.saveChain.catch(() => {}).then(() => this.persist());
		this.saveChain = save;
		return save;
	}

	private async persist(): Promise<void> {
		const adapter = this.app.vault.adapter;
		while (this.dirty) {
			const revision = this.revision;
			const data = JSON.stringify({ ...this.manifest, generation: ++this.generation });
			await adapter.write(this.tmpPath, data);
			await adapter.write(this.manifestPath, data);
			try { await adapter.remove(this.tmpPath); } catch { /* best effort */ }
			this.dirty = revision !== this.revision;
		}
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
		const previous = this.manifest.files[path];
		this.manifest.files[path] = { ...entry, revision: entry.revision ?? (previous?.hash === entry.hash ? previous.revision : undefined) };
		this.revision++;
		this.dirty = true;
	}

	/**
	 * Remove file entry
	 */
	removeEntry(path: string): void {
		delete this.manifest.files[path];
		this.revision++;
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
		this.revision++;
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
		this.revision++;
		this.dirty = true;
	}
}
