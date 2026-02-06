/**
 * Base cache — stores last-synced file content on disk for 3-way merge.
 * Uses the vault adapter to write files under the plugin's own directory.
 */

import type { DataAdapter } from 'obsidian';
import { MERGEABLE_EXTENSIONS } from '../types';

const BASES_DIR = '.obsidian/plugins/obsidian-crate/bases';

export class BaseCache {
	private adapter: DataAdapter;

	constructor(adapter: DataAdapter) {
		this.adapter = adapter;
	}

	/**
	 * Persist the synced content as the base version for future merges.
	 * No-op for non-mergeable extensions.
	 */
	async saveBase(path: string, content: ArrayBuffer): Promise<void> {
		if (!this.isMergeable(path)) return;

		const basePath = this.basePath(path);
		const folderPath = basePath.substring(0, basePath.lastIndexOf('/'));
		if (folderPath) {
			try {
				await this.adapter.mkdir(folderPath);
			} catch {
				// Folder might already exist
			}
		}
		await this.adapter.writeBinary(basePath, content);
	}

	/**
	 * Retrieve the stored base version, or null if none exists.
	 */
	async getBase(path: string): Promise<ArrayBuffer | null> {
		const basePath = this.basePath(path);
		if (await this.adapter.exists(basePath)) {
			return this.adapter.readBinary(basePath);
		}
		return null;
	}

	/**
	 * Remove the base version for a path.
	 */
	async removeBase(path: string): Promise<void> {
		const basePath = this.basePath(path);
		if (await this.adapter.exists(basePath)) {
			await this.adapter.remove(basePath);
		}
	}

	/**
	 * Recursively delete the entire bases directory.
	 */
	async clear(): Promise<void> {
		if (await this.adapter.exists(BASES_DIR)) {
			await this.removeRecursive(BASES_DIR);
		}
	}

	private basePath(path: string): string {
		return `${BASES_DIR}/${path}`;
	}

	private isMergeable(path: string): boolean {
		const ext = path.split('.').pop()?.toLowerCase() ?? '';
		return (MERGEABLE_EXTENSIONS as readonly string[]).includes(ext);
	}

	private async removeRecursive(dirPath: string): Promise<void> {
		const listing = await this.adapter.list(dirPath);

		// Remove files first
		for (const file of listing.files) {
			await this.adapter.remove(file);
		}

		// Recurse into subdirectories
		for (const folder of listing.folders) {
			await this.removeRecursive(folder);
		}

		// Remove the directory itself
		await this.adapter.rmdir(dirPath, false);
	}
}
