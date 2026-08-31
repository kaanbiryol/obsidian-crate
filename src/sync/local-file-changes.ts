import type { Vault } from 'obsidian';
import { getAllVaultFiles } from './file-discovery';
import type { FileEntry } from '../protocol/sync-types';

interface LocalFileManifest {
	getAllPaths(): string[];
	getEntry(path: string): FileEntry | undefined;
}

/**
 * Metadata-only safety net for local changes that did not produce a vault
 * event, such as edits made while startup synchronization had events paused.
 * Content is hashed only after a sync is actually scheduled.
 */
export async function hasLocalFileChanges(
	vault: Vault,
	manifest: LocalFileManifest,
	shouldIgnore: (path: string) => boolean,
): Promise<boolean> {
	const currentFiles = await getAllVaultFiles(vault, shouldIgnore);
	const currentPaths = new Set(currentFiles.map((file) => file.path));

	for (const file of currentFiles) {
		const tracked = manifest.getEntry(file.path);
		if (!tracked || tracked.size !== file.size || Date.parse(tracked.modified) !== file.mtime) {
			return true;
		}
	}

	for (const path of manifest.getAllPaths()) {
		if (shouldIgnore(path) || currentPaths.has(path)) continue;
		try {
			if (!await vault.adapter.exists(path)) return true;
		} catch {
			// Treat an uncertain adapter result as unchanged until the next check.
		}
	}

	return false;
}
